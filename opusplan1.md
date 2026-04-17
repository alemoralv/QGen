# OpusPlan1 — Plan de mejora de calidad de preguntas y exactitud de respuestas

> **Autor original del plan:** Opus 4.7
> **Ejecutor:** Sonnet 4.6
> **Alcance:** Backend únicamente (Python CLI en `qgen/` y rutas API de Next.js en `web/app/api/` y `web/lib/`). **No modificar UI** (`web/components/`, `web/app/page.tsx`) salvo que la exposición de nuevos parámetros de configuración así lo exija en un commit separado.
> **Idioma objetivo de las preguntas generadas:** Español de México.
> **Fecha:** 2026-04-17

---

## 0. Resumen ejecutivo

El proyecto actual (QGen) tiene una arquitectura limpia pero con **debilidades serias en la calidad de las preguntas y la exactitud de las respuestas**:

1. **Extracción de PDF frágil**: `pymupdf4llm` con fallback a `pypdf` no conserva estructura de tablas, listas jerárquicas, pies de página, ni maneja PDFs escaneados (el LSAR, CUF y RI son documentos regulatorios con abundantes artículos, incisos y tablas; si PDF es imagen, el resultado es basura).
2. **Segmentación ciega por páginas fijas** (`pages_per_segment: 10`): parte artículos a la mitad, rompe contexto y genera preguntas sobre fragmentos incompletos.
3. **Reparto uniforme de preguntas** (`allocator.py`): asigna lo mismo a un segmento denso que a uno con 2 párrafos. Distorsiona la distribución temática.
4. **Prompt genérico y débil**: no fuerza citado literal, no exige anclaje al texto fuente, no maneja dificultad de forma estructurada, mezcla idiomas, no tiene few-shot, no usa modo JSON del modelo, no usa system role.
5. **Validación post-generación inexistente**: no verifica que la respuesta esté contenida en el texto fuente, no deduplica preguntas, no detecta alucinaciones, no balancea tipos de pregunta.
6. **Manejo de errores rudimentario**: reintentos con backoff lineal, sin `jitter`, sin distinguir errores permanentes de transitorios, sin telemetría.
7. **Suplemento con contexto combinado** (en `main.py` y `route.ts`): concatena todo el PDF y pide las faltantes → prompt enorme, respuesta sesgada hacia el inicio, frecuentes truncamientos.
8. **Contrato `expectedResponse` ambiguo**: modelo a veces responde con ≤ 5 palabras, otras con un párrafo. Dificulta su uso en evaluación posterior.

Este plan ataca cada uno de los ocho puntos con cambios concretos, probados, incrementales, en español mexicano, **sin tocar la UI** salvo para propagar nuevos campos de `GenerationConfig` si al final del plan se decide exponerlos.

---

## 1. Convenciones globales del plan

- **Idioma de prompts al LLM**: los prompts de sistema van en **español mexicano** (antes estaban en inglés). Esto mejora consistentemente la salida en español cuando el documento fuente está en español, evita que el modelo cambie a inglés accidentalmente y reduce alucinaciones terminológicas.
- **Idioma del código, logs y comentarios**: mantener inglés. Solo los strings dirigidos al LLM o al usuario final (errores, mensajes UI) van en español mexicano.
- **Rutas relativas**: todas las rutas son relativas a la raíz `QGen/` salvo que se indique lo contrario.
- **Compatibilidad**: Python 3.10+ (no usar `match` exhaustivo ni features de 3.12 sin fallback). TypeScript estricto, Node 22.
- **No romper tests existentes**: todos los tests actuales en `tests/` deben seguir pasando. Si un test queda obsoleto, reemplazarlo por uno equivalente con la nueva API.
- **Numeración de tareas**: `T-<sección>.<índice>`. Sonnet debe ejecutarlas en el orden listado (hay dependencias).
- **Commits**: uno por sección principal (1 commit por cada sección `T-N`). Mensaje en inglés imperativo, cuerpo con bullets.

---

## 2. Análisis detallado del estado actual (para que Sonnet entienda el "por qué")

### 2.1 Flujo actual (Python CLI)

```
config.yaml ──▶ load_config ──▶ AppConfig
                                    │
documents/*.pdf ──▶ split_pdf_into_segments (md→txt fallback)
                         │
                         ▼
                    List[Segment]  (pages_per_segment=10, texto plano unido con \n\n)
                         │
                         ▼
         allocate_questions_across_segments  (reparto uniforme por segmento no vacío)
                         │
                         ▼
    por cada segmento con assign>0 ──▶ generate_qa_for_segment ──▶ LLM chat.completions
                                              │                         │
                                              │                         ▼
                                              │                   JSON array crudo
                                              ▼
                                        _extract_json_array (regex + repair)
                                              │
                                              ▼
                                        List[QARecord]
                         │
                         ▼
          _supplement_rows_if_needed (concatenar todo, pedir lo faltante)
                         │
                         ▼
              write_outputs_for_pdf (CSV + XLSX)
```

### 2.2 Debilidades concretas identificadas (referencia archivo:línea)

| # | Archivo | Línea(s) | Problema |
|---|---------|----------|----------|
| D1 | `qgen/pdf_splitter.py` | 14-19 | `extract_page_texts_txt` usa `pypdf` sin desactivar layout → pierde columnas |
| D2 | `qgen/pdf_splitter.py` | 54-73 | `extract_page_texts_markdown` no propaga información de tablas, listas, headers a nivel de segmento |
| D3 | `qgen/pdf_splitter.py` | 85-97 | Segmentación por páginas físicas ignora límites semánticos (artículos, capítulos) |
| D4 | `qgen/allocator.py` | 16-22 | Reparto uniforme: `base = total // len(active)`. Ignora densidad textual |
| D5 | `qgen/question_generator.py` | 46-68 | Prompt en inglés, sin role system, sin few-shot, sin exigencia de citado |
| D6 | `qgen/question_generator.py` | 119-127 | No usa `response_format={"type": "json_object"}` ni `json_schema` |
| D7 | `qgen/question_generator.py` | 159-205 | Sin deduplicación ni validación de groundedness |
| D8 | `qgen/main.py` | 38-50 | Suplemento concatena texto completo → prompt gigante, riesgo de truncado y sesgo |
| D9 | `qgen/config.py` | 36-43 | Falta `system_prompt`, `question_types`, `min_answer_words`, `max_answer_words`, `enable_grounding_check`, `enable_dedup` |
| D10 | `web/lib/pdfSplitter.ts` | 14-38 | `pdfjs-dist` junta ítems con `" "` y normaliza espacios → fusiona columnas |
| D11 | `web/app/api/generate/route.ts` | 10 | `maxDuration = 60` + sin paralelismo → PDFs grandes pueden no terminar |
| D12 | `web/lib/questionGenerator.ts` | 5-32 | Mismo prompt débil duplicado en TS |
| D13 | Ambos caminos | — | No hay contrato compartido: el prompt y la validación se mantienen por duplicado |

### 2.3 PDFs de trabajo

- **CUF.pdf** (6.6 MB): Circular Única de Fondos para el Retiro. Estructura por **artículos**, **disposiciones**, **transitorios**. Muchas tablas.
- **LSAR.pdf** (1.4 MB): Ley de los Sistemas de Ahorro para el Retiro. Estructura por **títulos → capítulos → artículos → fracciones → incisos**.
- **RI_new.pdf** (1.3 MB): Reglamento interno. Similar a LSAR.

La unidad semántica natural es el **artículo**, no la página. Hay artículos de ½ página y artículos de 5 páginas.

---

## 3. Arquitectura objetivo

```
                  ┌─────────────────────────────────────┐
                  │  StructuralExtractor (PyMuPDF)      │ ← preserva bloques, tablas, headers
                  └──────────────┬──────────────────────┘
                                 │
                  ┌──────────────▼──────────────────────┐
                  │  SemanticSegmenter                  │ ← detecta ARTÍCULO, CAPÍTULO, SECCIÓN
                  │   - fallback: page-window con       │   con regex de dominio regulatorio MX
                  │     overlap                         │
                  └──────────────┬──────────────────────┘
                                 │
                                 ▼
                        List[EnrichedSegment]
                                 │
                                 ▼
                  ┌─────────────────────────────────────┐
                  │  WeightedAllocator                  │ ← reparto ∝ tokens del segmento
                  │   (floor + largest-remainder)       │   con mínimo configurable por segmento
                  └──────────────┬──────────────────────┘
                                 │
                                 ▼
                  ┌─────────────────────────────────────┐
                  │  QuestionGenerator                  │ ← system prompt MX + JSON schema
                  │   - few-shot                        │   + response_format json_schema
                  │   - reintentos exp backoff + jitter │
                  │   - valida schema Pydantic          │
                  └──────────────┬──────────────────────┘
                                 │
                                 ▼
                        List[QARecord]  (por segmento)
                                 │
                                 ▼
                  ┌─────────────────────────────────────┐
                  │  QualityPipeline                    │
                  │   1. Grounding check (pasaje→resp)  │
                  │   2. Deduplicación semántica        │
                  │   3. Balance de tipos y dificultad  │
                  │   4. Anti-alucinación con citas     │
                  └──────────────┬──────────────────────┘
                                 │
                                 ▼
                  ┌─────────────────────────────────────┐
                  │  SmartSupplementer                  │ ← ya NO concatena todo: muestrea
                  │   segmentos sub-representados       │   por densidad y pide refuerzo
                  └──────────────┬──────────────────────┘
                                 │
                                 ▼
                         Exporter (CSV/XLSX)
```

---

## 4. Plan de ejecución por tareas

Las tareas siguen orden topológico. Donde aparece "Python + TS" significa replicar el cambio en ambos caminos.

### T-1. Enriquecer modelos y configuración (base)

**Objetivo:** darles a los módulos posteriores información estructural que hoy se pierde, y nuevos parámetros de calidad.

#### T-1.1. Ampliar `qgen/models.py`

Reemplazar el contenido actual por:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

QuestionType = Literal[
    "factual",        # qué/quién/cuándo/dónde
    "conceptual",     # definición/explicación
    "procedural",     # cómo/pasos
    "comparative",    # diferencia/contraste
    "application",    # aplicar a caso
    "reasoning",      # porqué/justificación
]

DifficultyLevel = Literal["basic", "intermediate", "advanced"]


@dataclass(slots=True)
class Segment:
    """Unidad de trabajo enviada al LLM."""
    source_pdf: str
    segment_index: int
    page_start: int
    page_end: int
    text: str
    # Nuevos campos ──────────────────────────────────────
    heading: Optional[str] = None             # p.ej. "Artículo 47 bis"
    heading_path: tuple[str, ...] = field(default_factory=tuple)
    # p.ej. ("TÍTULO TERCERO", "Capítulo II", "Artículo 47 bis")
    token_estimate: int = 0                   # heurística len/4
    has_tables: bool = False
    has_lists: bool = False
    language: str = "es"                      # ISO-639-1

    @property
    def is_usable(self) -> bool:
        return bool(self.text.strip()) and self.token_estimate >= 40


@dataclass(slots=True)
class QARecord:
    question: str
    expectedResponse: str
    sourcePdf: str
    segmentIndex: int
    pageStart: int
    pageEnd: int
    # Nuevos campos ──────────────────────────────────────
    heading: Optional[str] = None
    questionType: Optional[QuestionType] = None
    difficulty: Optional[DifficultyLevel] = None
    supportingQuote: str = ""                  # cita literal del texto fuente
    confidence: float = 1.0                    # 0..1 post-validación
```

**Razón de cada campo:**
- `heading` / `heading_path`: permite al prompt decirle al modelo "estás generando preguntas del Artículo 47 bis", reduciendo confusión entre artículos vecinos.
- `token_estimate`: base del nuevo `WeightedAllocator`.
- `has_tables` / `has_lists`: permite al prompt adaptar instrucciones.
- `supportingQuote`: cita literal que ancla la respuesta → verificable.
- `confidence`: producto de checks del `QualityPipeline`.

#### T-1.2. Ampliar `qgen/config.py`

Añadir los siguientes campos al `AppConfig` (con sus defaults) y validarlos:

```python
# Dominio regulatorio / estilo
locale: str = "es-MX"                         # influye en prompt
domain_hint: str = (
    "Documento regulatorio mexicano en materia de ahorro para el retiro "
    "(SAR, CONSAR, AFORES, SIEFORES)."
)

# Segmentación semántica
segmentation_strategy: str = "semantic"       # "semantic" | "pages"
segment_target_tokens: int = 1200             # objetivo por segmento semántico
segment_max_tokens: int = 2000
segment_min_tokens: int = 200
segment_overlap_tokens: int = 120             # solo para estrategia "pages"

# Reparto
allocation_strategy: str = "weighted"         # "weighted" | "uniform"
min_questions_per_segment: int = 0
max_questions_per_segment: int = 50

# Generación
question_types: list[str] = field(default_factory=lambda: [
    "factual", "conceptual", "procedural", "application", "reasoning"
])
question_types_balance: str = "auto"          # "auto" | "equal"
min_answer_words: int = 12
max_answer_words: int = 80
require_supporting_quote: bool = True
json_mode: str = "json_schema"                # "json_schema" | "json_object" | "off"
system_prompt_override: Optional[str] = None  # para casos especiales

# Validación de calidad
enable_grounding_check: bool = True
grounding_min_overlap: float = 0.30           # % tokens respuesta ∈ texto fuente
enable_dedup: bool = True
dedup_similarity_threshold: float = 0.88      # Jaccard sobre n-gramas 3
enable_answer_length_guard: bool = True

# Suplemento
supplement_strategy: str = "targeted"         # "targeted" | "combined" | "off"
supplement_max_attempts: int = 2

# Concurrencia
max_concurrent_segments: int = 4              # solo TS/Node

# Reintentos
retry_jitter_seconds: float = 1.0
```

Actualizar `validate()` para rangos razonables (`0 ≤ grounding_min_overlap ≤ 1`, `min_answer_words ≤ max_answer_words`, etc.).

**Retrocompatibilidad**: todos los campos tienen default; YAMLs antiguos siguen funcionando. En `config.yaml` actualizar para reflejar defaults nuevos relevantes (ver T-10).

#### T-1.3. Replicar en TS (`web/lib/types.ts`)

Añadir los mismos campos a `GenerationConfig`, `Segment`, `QARecord`. Marcar los nuevos como opcionales por retrocompatibilidad con la UI, pero el `route.ts` debe aplicar defaults cuando no vengan (ver T-2.3).

---

### T-2. Extractor estructural de PDFs

**Objetivo:** usar PyMuPDF directamente (en vez de `pymupdf4llm`) para preservar bloques, detectar encabezados regulatorios, tablas y generar metadatos de estructura.

#### T-2.1. Crear `qgen/extractors/structural.py`

```python
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pymupdf  # fitz

LOGGER = logging.getLogger("qgen.extractor")

# Encabezados típicos del dominio SAR (regulación mexicana)
HEADING_PATTERNS = [
    re.compile(r"^\s*TÍTULO\s+[A-ZÁÉÍÓÚ]+", re.IGNORECASE),
    re.compile(r"^\s*CAPÍTULO\s+[A-ZÁÉÍÓÚ]+", re.IGNORECASE),
    re.compile(r"^\s*SECCIÓN\s+[A-ZÁÉÍÓÚ]+", re.IGNORECASE),
    re.compile(r"^\s*Art[íi]culo\s+\d+(\s*(bis|ter|quáter|quinquies))?\.?", re.IGNORECASE),
    re.compile(r"^\s*DISPOSICIONES?\s+", re.IGNORECASE),
    re.compile(r"^\s*TRANSITORI[OA]S?\s*$", re.IGNORECASE),
]


@dataclass(slots=True)
class PageBlock:
    page_index: int          # 0-based
    text: str
    is_heading: bool
    heading_kind: str        # "titulo" | "capitulo" | "seccion" | "articulo" | ""
    bbox: tuple[float, float, float, float]
    font_size: float


@dataclass(slots=True)
class StructuralPage:
    index: int               # 0-based
    blocks: list[PageBlock]
    plain_text: str
    has_tables: bool


def _classify_heading(line: str) -> str:
    if HEADING_PATTERNS[0].match(line): return "titulo"
    if HEADING_PATTERNS[1].match(line): return "capitulo"
    if HEADING_PATTERNS[2].match(line): return "seccion"
    if HEADING_PATTERNS[3].match(line): return "articulo"
    if HEADING_PATTERNS[4].match(line) or HEADING_PATTERNS[5].match(line):
        return "disposicion"
    return ""


def extract_structural(pdf_path: str | Path) -> list[StructuralPage]:
    """Extrae bloques con metadatos tipográficos. NO hace OCR."""
    doc = pymupdf.open(str(pdf_path))
    pages: list[StructuralPage] = []
    try:
        for i, page in enumerate(doc):
            page_dict = page.get_text("dict")
            blocks: list[PageBlock] = []
            for block in page_dict.get("blocks", []):
                if block.get("type", 0) != 0:  # 0 = text
                    continue
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    if not spans:
                        continue
                    text = "".join(s.get("text", "") for s in spans).strip()
                    if not text:
                        continue
                    max_size = max(s.get("size", 0.0) for s in spans)
                    kind = _classify_heading(text)
                    is_heading = bool(kind) or max_size >= 13.5
                    bbox = tuple(line.get("bbox", (0, 0, 0, 0)))
                    blocks.append(PageBlock(
                        page_index=i,
                        text=text,
                        is_heading=is_heading,
                        heading_kind=kind,
                        bbox=bbox,
                        font_size=max_size,
                    ))
            # Detección de tablas con PyMuPDF (heurístico)
            has_tables = False
            try:
                tables = page.find_tables()
                has_tables = len(tables.tables) > 0
            except Exception:  # noqa: BLE001
                has_tables = False
            plain_text = "\n".join(b.text for b in blocks).strip()
            pages.append(StructuralPage(
                index=i,
                blocks=blocks,
                plain_text=plain_text,
                has_tables=has_tables,
            ))
    finally:
        doc.close()
    return pages


def detect_language(pages: Iterable[StructuralPage]) -> str:
    """Heurística muy barata: busca palabras funcionales ES vs EN."""
    sample = " ".join(p.plain_text for p in list(pages)[:3]).lower()
    es = sum(sample.count(w) for w in (" de ", " la ", " que ", " el ", " para "))
    en = sum(sample.count(w) for w in (" the ", " of ", " and ", " for ", " to "))
    return "es" if es >= en else "en"
```

**Tests (`tests/test_structural_extractor.py`):** fixture con un PDF sintético de 3 páginas generado on-the-fly con PyMuPDF que contenga "Artículo 1.", "Capítulo II", texto normal. Verificar que los headings se clasifican correctamente.

#### T-2.2. Replicar en TS (`web/lib/extractors/structural.ts`)

`pdfjs-dist` expone `textContent.items[].transform` (matriz 3x3) de donde se obtiene `fontSize = transform[0]`. Usar eso para detectar encabezados por tamaño. Clasificar con los mismos regex.

```typescript
import type { Segment } from "../types";

export interface PageBlock {
  pageIndex: number;
  text: string;
  isHeading: boolean;
  headingKind: "" | "titulo" | "capitulo" | "seccion" | "articulo" | "disposicion";
  fontSize: number;
}

export interface StructuralPage {
  index: number;
  blocks: PageBlock[];
  plainText: string;
}

const HEADING_PATTERNS: Array<[RegExp, PageBlock["headingKind"]]> = [
  [/^\s*TÍTULO\s+[A-ZÁÉÍÓÚ]+/i, "titulo"],
  [/^\s*CAPÍTULO\s+[A-ZÁÉÍÓÚ]+/i, "capitulo"],
  [/^\s*SECCIÓN\s+[A-ZÁÉÍÓÚ]+/i, "seccion"],
  [/^\s*Art[íi]culo\s+\d+(\s*(bis|ter|quáter|quinquies))?\.?/i, "articulo"],
  [/^\s*DISPOSICIONES?\s+/i, "disposicion"],
  [/^\s*TRANSITORI[OA]S?\s*$/i, "disposicion"],
];

function classifyHeading(line: string): PageBlock["headingKind"] {
  for (const [re, kind] of HEADING_PATTERNS) if (re.test(line)) return kind;
  return "";
}

export async function extractStructural(buffer: Uint8Array): Promise<StructuralPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // @ts-expect-error runtime option
  pdfjs.GlobalWorkerOptions.workerSrc = false;
  const doc = await pdfjs.getDocument({
    data: buffer, disableFontFace: true, useSystemFonts: false, isEvalSupported: false,
  }).promise;
  const pages: StructuralPage[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Agrupar items por línea Y (redondeado) para reconstruir renglones
    const byLine = new Map<number, Array<{ text: string; fontSize: number; x: number }>>();
    for (const item of content.items as Array<{
      str: string; transform: number[]; width?: number;
    }>) {
      if (!("str" in item) || typeof item.str !== "string") continue;
      const y = Math.round(item.transform[5]);  // coord Y
      const fontSize = Math.abs(item.transform[0]) || 10;
      const x = item.transform[4];
      if (!byLine.has(y)) byLine.set(y, []);
      byLine.get(y)!.push({ text: item.str, fontSize, x });
    }
    // Ordenar renglones de arriba a abajo (Y mayor = más alto en PDF)
    const sortedLines = [...byLine.entries()].sort((a, b) => b[0] - a[0]);
    const blocks: PageBlock[] = [];
    for (const [, parts] of sortedLines) {
      parts.sort((a, b) => a.x - b.x);
      const text = parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const fontSize = Math.max(...parts.map((p) => p.fontSize));
      const headingKind = classifyHeading(text);
      blocks.push({
        pageIndex: i - 1,
        text,
        isHeading: Boolean(headingKind) || fontSize >= 13.5,
        headingKind,
        fontSize,
      });
    }
    pages.push({
      index: i - 1,
      blocks,
      plainText: blocks.map((b) => b.text).join("\n"),
    });
  }
  await doc.destroy();
  return pages;
}
```

#### T-2.3. Eliminar la ambigüedad `md`/`txt`

Deprecar `pdf_extract_format` y `pdf_extract_fallback_to_txt` (aceptarlos en `config.yaml` pero emitir `LOGGER.warning("deprecated: ignored in favor of structural extractor")`). El nuevo extractor es único.

---

### T-3. Segmentador semántico

**Objetivo:** partir por artículos/capítulos en vez de por páginas fijas, con ventanas de desborde cuando un artículo excede `segment_max_tokens`.

#### T-3.1. Crear `qgen/segmenter.py`

```python
from __future__ import annotations

import re
from dataclasses import dataclass

from qgen.extractors.structural import StructuralPage, PageBlock, detect_language
from qgen.models import Segment


def _approx_tokens(s: str) -> int:
    """Muy barata: ~1 token por 4 caracteres."""
    return max(1, len(s) // 4)


@dataclass(slots=True)
class _BoundarySpan:
    heading: str
    heading_path: tuple[str, ...]
    start_page: int          # 1-based, inclusive
    end_page: int            # 1-based, inclusive
    text: str
    has_tables: bool


def _path_update(current: list[str], block: PageBlock) -> list[str]:
    """Mantiene pila heading_path coherente: al entrar a capítulo se poda artículo anterior."""
    kind_rank = {"titulo": 0, "capitulo": 1, "seccion": 2, "articulo": 3, "disposicion": 3}
    rank = kind_rank.get(block.heading_kind, 99)
    if rank == 99:
        return current
    trimmed = [h for h in current if kind_rank.get(_infer_kind(h), 99) < rank]
    trimmed.append(block.text)
    return trimmed


def _infer_kind(heading_text: str) -> str:
    t = heading_text.upper()
    if t.startswith("TÍTULO"): return "titulo"
    if t.startswith("CAPÍTULO"): return "capitulo"
    if t.startswith("SECCIÓN"): return "seccion"
    if re.match(r"^ART[IÍ]CULO", t): return "articulo"
    return "disposicion"


def segment_by_structure(
    source_pdf: str,
    pages: list[StructuralPage],
    *,
    target_tokens: int,
    max_tokens: int,
    min_tokens: int,
) -> list[Segment]:
    """Segmenta por encabezado 'articulo' principalmente, fusionando cortos
    y subdividiendo largos."""
    spans: list[_BoundarySpan] = []
    current_path: list[str] = []
    current_buf: list[str] = []
    current_start_page = 1
    current_heading = ""
    current_has_tables = False

    def _flush(end_page: int) -> None:
        text = "\n".join(current_buf).strip()
        if text:
            spans.append(_BoundarySpan(
                heading=current_heading,
                heading_path=tuple(current_path),
                start_page=current_start_page,
                end_page=end_page,
                text=text,
                has_tables=current_has_tables,
            ))

    for page in pages:
        for block in page.blocks:
            if block.is_heading and block.heading_kind in {"articulo", "disposicion"}:
                _flush(page.index + 1)
                current_buf = [block.text]
                current_start_page = page.index + 1
                current_heading = block.text
                current_has_tables = page.has_tables
                current_path = _path_update(current_path, block)
            elif block.is_heading and block.heading_kind in {"titulo", "capitulo", "seccion"}:
                current_path = _path_update(current_path, block)
                current_buf.append(block.text)
            else:
                current_buf.append(block.text)
        current_has_tables = current_has_tables or page.has_tables
    _flush(pages[-1].index + 1 if pages else 1)

    # Fusionar cortos con vecinos hasta min_tokens
    fused: list[_BoundarySpan] = []
    for span in spans:
        if fused and _approx_tokens(fused[-1].text) < min_tokens:
            prev = fused[-1]
            fused[-1] = _BoundarySpan(
                heading=prev.heading or span.heading,
                heading_path=prev.heading_path or span.heading_path,
                start_page=prev.start_page,
                end_page=span.end_page,
                text=prev.text + "\n\n" + span.text,
                has_tables=prev.has_tables or span.has_tables,
            )
        else:
            fused.append(span)

    # Subdividir largos
    segments: list[Segment] = []
    for span in fused:
        tokens = _approx_tokens(span.text)
        if tokens <= max_tokens:
            segments.append(_to_segment(source_pdf, len(segments), span))
            continue
        # Partir por párrafos manteniendo heading
        parts = span.text.split("\n\n")
        bucket: list[str] = []
        bucket_tokens = 0
        for part in parts:
            pt = _approx_tokens(part)
            if bucket and bucket_tokens + pt > target_tokens:
                sub = _BoundarySpan(
                    heading=f"{span.heading} (parte {len([s for s in segments if s.heading == span.heading]) + 1})",
                    heading_path=span.heading_path,
                    start_page=span.start_page,
                    end_page=span.end_page,
                    text="\n\n".join(bucket),
                    has_tables=span.has_tables,
                )
                segments.append(_to_segment(source_pdf, len(segments), sub))
                bucket = [part]
                bucket_tokens = pt
            else:
                bucket.append(part)
                bucket_tokens += pt
        if bucket:
            sub = _BoundarySpan(
                heading=span.heading,
                heading_path=span.heading_path,
                start_page=span.start_page,
                end_page=span.end_page,
                text="\n\n".join(bucket),
                has_tables=span.has_tables,
            )
            segments.append(_to_segment(source_pdf, len(segments), sub))
    return segments


def _to_segment(source_pdf: str, index: int, span: _BoundarySpan) -> Segment:
    return Segment(
        source_pdf=source_pdf,
        segment_index=index,
        page_start=span.start_page,
        page_end=span.end_page,
        text=span.text,
        heading=span.heading or None,
        heading_path=span.heading_path,
        token_estimate=_approx_tokens(span.text),
        has_tables=span.has_tables,
        has_lists=bool(re.search(r"^\s*(I{1,3}|IV|V|VI{0,3}|IX|X)\.?\s", span.text, re.MULTILINE)),
        language="es",
    )
```

#### T-3.2. Fallback a ventanas paginadas con overlap

Cuando `segmentation_strategy == "pages"` o no se detectaron encabezados:

```python
def segment_by_pages(
    source_pdf: str,
    pages: list[StructuralPage],
    *,
    pages_per_segment: int,
    overlap_tokens: int,
) -> list[Segment]:
    segments: list[Segment] = []
    for start in range(0, len(pages), pages_per_segment):
        end = min(start + pages_per_segment, len(pages))
        window = pages[start:end]
        text = "\n\n".join(p.plain_text for p in window if p.plain_text.strip()).strip()
        if not text:
            continue
        # Overlap textual con segmento previo (útil para no partir definiciones)
        if segments and overlap_tokens > 0:
            tail = segments[-1].text[-overlap_tokens * 4 :]
            text = tail + "\n\n" + text
        segments.append(Segment(
            source_pdf=source_pdf,
            segment_index=len(segments),
            page_start=start + 1,
            page_end=end,
            text=text,
            token_estimate=_approx_tokens(text),
            has_tables=any(p.has_tables for p in window),
            language="es",
        ))
    return segments
```

#### T-3.3. Reescribir `qgen/pdf_splitter.py`

```python
from __future__ import annotations

import logging
from pathlib import Path

from qgen.extractors.structural import extract_structural, detect_language
from qgen.models import Segment
from qgen.segmenter import segment_by_structure, segment_by_pages

LOGGER = logging.getLogger("qgen")


def split_pdf_into_segments(
    pdf_path: str | Path,
    pages_per_segment: int,
    *,
    strategy: str = "semantic",
    target_tokens: int = 1200,
    max_tokens: int = 2000,
    min_tokens: int = 200,
    overlap_tokens: int = 120,
    # Flags legacy ignorados (retrocompatibilidad):
    extract_format: str | None = None,
    fallback_to_txt: bool | None = None,
) -> list[Segment]:
    if extract_format or fallback_to_txt is not None:
        LOGGER.warning(
            "pdf_extract_format/pdf_extract_fallback_to_txt are deprecated; "
            "the structural extractor is used unconditionally."
        )
    path = Path(pdf_path)
    pages = extract_structural(path)
    lang = detect_language(pages)
    if lang != "es":
        LOGGER.info("Detected non-Spanish content in %s (lang=%s)", path.name, lang)

    if strategy == "semantic":
        segments = segment_by_structure(
            path.name, pages,
            target_tokens=target_tokens,
            max_tokens=max_tokens,
            min_tokens=min_tokens,
        )
        if len(segments) < 2:
            LOGGER.warning(
                "Semantic segmentation yielded %d segment(s); falling back to page windows.",
                len(segments),
            )
            segments = segment_by_pages(
                path.name, pages,
                pages_per_segment=pages_per_segment,
                overlap_tokens=overlap_tokens,
            )
    else:
        segments = segment_by_pages(
            path.name, pages,
            pages_per_segment=pages_per_segment,
            overlap_tokens=overlap_tokens,
        )
    # Forzar language detectado
    for s in segments:
        s.language = lang
    return segments
```

#### T-3.4. Replicar segmentador en TS

Archivo: `web/lib/segmenter.ts`. Traducir las mismas funciones (`segmentByStructure`, `segmentByPages`) con los tipos de `types.ts`. Usar la misma heurística. Verificar que los tests `test_pdf_splitter.py` siguen pasando ajustándolos a que `splitPdfIntoSegments` acepte `{strategy, targetTokens, ...}`.

---

### T-4. Reparto ponderado de preguntas

#### T-4.1. Reescribir `qgen/allocator.py`

```python
from __future__ import annotations

from qgen.models import Segment


def allocate_questions_across_segments(
    segments: list[Segment],
    total_questions: int,
    *,
    strategy: str = "weighted",
    min_per_segment: int = 0,
    max_per_segment: int = 50,
) -> dict[int, int]:
    """Reparto proporcional al `token_estimate` de cada segmento usable.

    Usa el método de los *largest remainders* para minimizar sesgos.
    """
    if total_questions <= 0:
        raise ValueError("total_questions must be > 0")
    usable = [(i, s) for i, s in enumerate(segments) if s.is_usable]
    if not usable:
        return {}

    if strategy == "uniform":
        base = total_questions // len(usable)
        remainder = total_questions % len(usable)
        out = {i: base for i, _ in usable}
        for i, _ in usable[:remainder]:
            out[i] += 1
        return _apply_bounds(out, min_per_segment, max_per_segment, total_questions, usable)

    weights = [s.token_estimate for _, s in usable]
    total_w = sum(weights) or 1
    raw = [total_questions * w / total_w for w in weights]
    floors = [int(r) for r in raw]
    remainders = [(raw[j] - floors[j], j) for j in range(len(usable))]
    assigned = sum(floors)
    leftover = total_questions - assigned
    # Los segmentos con mayor residuo se quedan con las preguntas extra
    for _, j in sorted(remainders, reverse=True)[:leftover]:
        floors[j] += 1

    out = {usable[j][0]: floors[j] for j in range(len(usable))}
    return _apply_bounds(out, min_per_segment, max_per_segment, total_questions, usable)


def _apply_bounds(
    out: dict[int, int],
    lo: int,
    hi: int,
    target_total: int,
    usable: list[tuple[int, Segment]],
) -> dict[int, int]:
    if lo <= 0 and hi >= target_total:
        return out
    # Aplicar cotas conservando el total
    for k in out:
        out[k] = max(lo, min(hi, out[k]))
    delta = target_total - sum(out.values())
    if delta == 0:
        return out
    # Redistribuir delta priorizando segmentos con más tokens
    order = sorted(usable, key=lambda t: -t[1].token_estimate)
    step = 1 if delta > 0 else -1
    for i, _ in order:
        while delta != 0 and lo <= out[i] + step <= hi:
            out[i] += step
            delta -= step
            if delta == 0:
                break
        if delta == 0:
            break
    return out
```

**Tests nuevos** en `tests/test_allocator.py`:

```python
def test_weighted_allocator_biases_by_tokens():
    big = Segment("a.pdf", 0, 1, 10, "x" * 4000, token_estimate=1000)
    small = Segment("a.pdf", 1, 11, 15, "y" * 400, token_estimate=100)
    out = allocate_questions_across_segments([big, small], 11)
    assert out[0] > out[1]
    assert sum(out.values()) == 11


def test_allocator_respects_min_per_segment():
    segs = [Segment("a.pdf", i, i+1, i+1, "x" * 800, token_estimate=200) for i in range(5)]
    out = allocate_questions_across_segments(segs, 20, min_per_segment=2)
    assert all(v >= 2 for v in out.values())
    assert sum(out.values()) == 20
```

#### T-4.2. Replicar en `web/lib/allocator.ts`

Mismo algoritmo, API: `allocateQuestionsAcrossSegments(segments, totalQuestions, { strategy, minPerSegment, maxPerSegment })`.

---

### T-5. Prompts mejorados y salida estructurada

**Objetivo:** cambiar de un prompt genérico a un prompt de dos mensajes (`system` + `user`) en español mexicano, con few-shot de alta calidad y JSON Schema estricto.

#### T-5.1. Nuevo módulo `qgen/prompts.py`

```python
from __future__ import annotations

from qgen.models import Segment


SYSTEM_PROMPT_MX = """\
Eres un generador profesional de reactivos de evaluación para documentos regulatorios mexicanos del Sistema de Ahorro para el Retiro (SAR, CONSAR, AFORE, SIEFORE).
Tu tarea es producir preguntas y respuestas en ESPAÑOL DE MÉXICO, exclusivamente a partir del fragmento provisto. No inventes artículos, cifras, fechas, nombres ni siglas que no aparezcan literalmente en el fragmento.

Reglas obligatorias:
1. La respuesta (expectedResponse) debe ser verificable PALABRA POR PALABRA contra el fragmento. Si algún dato no está en el fragmento, NO lo incluyas.
2. La respuesta debe incluir la cita literal que la sustenta en el campo supportingQuote (mínimo 10 palabras, máximo 50, tal como aparece en el fragmento).
3. Cada pregunta debe: (a) no empezar con "¿Según el texto...?", (b) ser comprensible sin leer la pregunta anterior, (c) no repetir preguntas previas del mismo lote.
4. Distribuye los tipos de pregunta según la lista permitida (questionType).
5. La dificultad (difficulty) refleja la complejidad cognitiva: basic (recordar), intermediate (comprender/aplicar), advanced (analizar/justificar).
6. Longitud de respuesta: entre {min_words} y {max_words} palabras. Redacción formal, técnica, pero clara.
7. NO uses markdown, asteriscos, ni encabezados en las respuestas.
8. Devuelve SOLO el JSON pedido. Nada antes, nada después.

Prohibido:
- Preguntas del tipo "¿qué dice el artículo X?" sin especificar contenido.
- Respuestas que digan "el texto indica que..." o "según el documento...".
- Mezclar contenido de otros artículos o capítulos no presentes en el fragmento.
- Traducir términos técnicos (p. ej., mantener "SIEFORE", "CONSAR", "cuenta individual").
"""


FEWSHOT_ASSISTANT = """\
[
  {
    "question": "¿Cuál es el plazo máximo en días hábiles que tiene una Afore para resolver una solicitud de traspaso entre SIEFORES?",
    "expectedResponse": "Veinte días hábiles contados a partir de que se reciba la solicitud completa del trabajador, de acuerdo con el artículo referido.",
    "supportingQuote": "resolverá la solicitud de traspaso en un plazo no mayor a veinte días hábiles contados a partir de la recepción",
    "questionType": "factual",
    "difficulty": "basic"
  },
  {
    "question": "Explica por qué la CONSAR puede requerir información adicional a las Administradoras durante un procedimiento de supervisión.",
    "expectedResponse": "Porque la CONSAR está facultada para verificar el cumplimiento de las disposiciones aplicables, solicitar documentación soporte y practicar visitas de inspección para proteger los intereses de los trabajadores.",
    "supportingQuote": "la Comisión podrá requerir información adicional y practicar visitas de inspección para verificar el cumplimiento",
    "questionType": "reasoning",
    "difficulty": "intermediate"
  }
]
"""


QA_JSON_SCHEMA = {
    "name": "qa_batch",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "question", "expectedResponse", "supportingQuote",
                        "questionType", "difficulty",
                    ],
                    "properties": {
                        "question": {"type": "string", "minLength": 10},
                        "expectedResponse": {"type": "string", "minLength": 10},
                        "supportingQuote": {"type": "string", "minLength": 10},
                        "questionType": {
                            "type": "string",
                            "enum": [
                                "factual", "conceptual", "procedural",
                                "comparative", "application", "reasoning",
                            ],
                        },
                        "difficulty": {
                            "type": "string",
                            "enum": ["basic", "intermediate", "advanced"],
                        },
                    },
                },
            }
        },
    },
}


def build_system_prompt(*, min_words: int, max_words: int, override: str | None = None) -> str:
    if override:
        return override
    return SYSTEM_PROMPT_MX.format(min_words=min_words, max_words=max_words)


def build_user_prompt(
    segment: Segment,
    *,
    question_count: int,
    question_types: list[str],
    difficulty_mode: str,
    question_instructions: str,
    domain_hint: str,
    require_quote: bool,
) -> str:
    heading = segment.heading or "(sin encabezado)"
    path = " › ".join(segment.heading_path) if segment.heading_path else ""
    table_hint = "\nEl fragmento contiene tablas: prefiere preguntas sobre datos concretos." if segment.has_tables else ""
    list_hint = "\nEl fragmento contiene listados enumerados (fracciones/incisos): aprovéchalos." if segment.has_lists else ""
    types_str = ", ".join(question_types)
    return f"""\
Contexto del documento: {domain_hint}
PDF: {segment.source_pdf}
Ruta estructural: {path or heading}
Encabezado del fragmento: {heading}
Rango de páginas: {segment.page_start}-{segment.page_end}
Tipos de pregunta permitidos (distribuye entre ellos): {types_str}
Modo de dificultad: {difficulty_mode}
Cantidad exacta de pares a generar: {question_count}
Incluir supportingQuote como cita literal: {"sí" if require_quote else "opcional"}

Instrucciones adicionales del usuario:
{question_instructions}
{table_hint}{list_hint}

Fragmento fuente (ÚNICA fuente permitida):
\"\"\"
{segment.text}
\"\"\"

Responde con un objeto JSON con clave "items" conteniendo un arreglo de {question_count} objetos con las claves:
question, expectedResponse, supportingQuote, questionType, difficulty.
"""
```

#### T-5.2. Refactorizar `qgen/question_generator.py`

Usar `chat.completions` con `response_format={"type": "json_schema", "json_schema": QA_JSON_SCHEMA}` cuando `json_mode == "json_schema"`. Si el gateway lo rechaza (error 400 con mención a `response_format` o `json_schema`), degradar a `{"type": "json_object"}`; si tampoco, degradar a parse vía regex. Detectar con función análoga a `_gateway_rejects_temperature_param`:

```python
def _gateway_rejects_response_format(exc: BaseException, mode: str) -> bool:
    status = getattr(exc, "status_code", None)
    if status != 400:
        return False
    body = getattr(exc, "body", None) or {}
    err = body.get("error") if isinstance(body, dict) else {}
    msg = (err or {}).get("message", "").lower() if isinstance(err, dict) else str(exc).lower()
    if "response_format" in msg or "json_schema" in msg:
        return True
    if mode == "json_schema" and "schema" in msg and "unsupported" in msg:
        return True
    return False
```

El `complete()` debe incluir `messages=[{"role":"system", ...}, {"role":"user", ...}]`.

Añadir al request: `top_p=1.0`, `presence_penalty=0.2`, `frequency_penalty=0.2` (ayudan a reducir repeticiones entre preguntas). Si el gateway los rechaza, caer a sin ellos de forma persistente por `_omit_penalty`.

#### T-5.3. Nueva función `generate_qa_for_segment` con validación Pydantic

Instalar `pydantic` (añadir a `requirements.txt`). Definir:

```python
from pydantic import BaseModel, Field, ValidationError, field_validator

class _QAItem(BaseModel):
    question: str = Field(min_length=10)
    expectedResponse: str = Field(min_length=10)
    supportingQuote: str = Field(min_length=10)
    questionType: str
    difficulty: str

    @field_validator("question")
    @classmethod
    def _no_meta_phrasing(cls, v: str) -> str:
        lowered = v.lower()
        banned = ("según el texto", "de acuerdo con el texto", "el documento indica")
        if any(b in lowered for b in banned):
            raise ValueError("meta-phrasing forbidden")
        return v


class _QABatch(BaseModel):
    items: list[_QAItem]
```

En `generate_qa_for_segment`, validar el JSON contra `_QABatch`. Si falla, registrar `ValidationError` y reintentar; después de agotar intentos, retornar los ítems que sí validaron parcialmente (best effort) en vez de levantar excepción, siempre que haya ≥ 50% de los pedidos.

#### T-5.4. Replicar en `web/lib/prompts.ts` y `web/lib/questionGenerator.ts`

Usar `zod` para validación (añadir a `package.json`: `"zod": "^3.23.8"`). Definir `QaBatchSchema` equivalente. OpenAI SDK en TS acepta `response_format: { type: "json_schema", json_schema: {...} }`.

---

### T-6. Pipeline de calidad post-generación

Archivo nuevo: `qgen/quality.py`.

#### T-6.1. Grounding check

```python
from __future__ import annotations

import re
from collections.abc import Iterable

from qgen.models import QARecord, Segment


_WORD_RE = re.compile(r"\w+", re.UNICODE)

def _tokens(s: str) -> set[str]:
    return {m.group().lower() for m in _WORD_RE.finditer(s)}


def grounding_score(record: QARecord, segment_text: str) -> float:
    """Fracción de tokens de la respuesta presentes en el texto fuente.

    Se ignoran tokens muy cortos (stop-words ruidosas).
    """
    answer_tokens = {t for t in _tokens(record.expectedResponse) if len(t) >= 4}
    if not answer_tokens:
        return 0.0
    source_tokens = _tokens(segment_text)
    hits = sum(1 for t in answer_tokens if t in source_tokens)
    return hits / len(answer_tokens)


def quote_grounded(record: QARecord, segment_text: str) -> bool:
    """supportingQuote aparece como substring (normalizado de espacios) en el texto."""
    def norm(x: str) -> str:
        return re.sub(r"\s+", " ", x).strip().lower()
    return norm(record.supportingQuote) in norm(segment_text) if record.supportingQuote else False
```

#### T-6.2. Deduplicación semántica barata

```python
def _ngrams(text: str, n: int = 3) -> set[tuple[str, ...]]:
    toks = [t.lower() for t in _WORD_RE.findall(text) if len(t) >= 3]
    return {tuple(toks[i:i + n]) for i in range(max(0, len(toks) - n + 1))}


def jaccard(a: set[tuple[str, ...]], b: set[tuple[str, ...]]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / max(1, len(a | b))


def deduplicate(records: list[QARecord], threshold: float) -> list[QARecord]:
    kept: list[QARecord] = []
    ngram_cache: list[set[tuple[str, ...]]] = []
    for rec in records:
        ng = _ngrams(rec.question)
        if any(jaccard(ng, other) >= threshold for other in ngram_cache):
            continue
        kept.append(rec)
        ngram_cache.append(ng)
    return kept
```

#### T-6.3. Balance de tipos

```python
def enforce_type_balance(
    records: list[QARecord],
    allowed_types: list[str],
    mode: str = "auto",
) -> list[QARecord]:
    if mode != "equal" or not allowed_types:
        return records
    buckets: dict[str, list[QARecord]] = {t: [] for t in allowed_types}
    other: list[QARecord] = []
    for r in records:
        if r.questionType in buckets:
            buckets[r.questionType].append(r)
        else:
            other.append(r)
    target = len(records) // len(allowed_types)
    balanced: list[QARecord] = []
    for t in allowed_types:
        balanced.extend(buckets[t][:target])
    balanced.extend(other)
    return balanced or records
```

#### T-6.4. Orquestador `QualityPipeline`

```python
from dataclasses import dataclass

@dataclass(slots=True)
class QualityStats:
    dropped_not_grounded: int = 0
    dropped_dup: int = 0
    dropped_length: int = 0


def run_quality_pipeline(
    records: list[QARecord],
    segment_texts: dict[int, str],
    *,
    min_grounding: float,
    min_answer_words: int,
    max_answer_words: int,
    dedup: bool,
    dedup_threshold: float,
    require_quote: bool,
    allowed_types: list[str],
    type_balance_mode: str,
) -> tuple[list[QARecord], QualityStats]:
    stats = QualityStats()
    kept: list[QARecord] = []
    for r in records:
        words = len(_WORD_RE.findall(r.expectedResponse))
        if words < min_answer_words or words > max_answer_words:
            stats.dropped_length += 1
            continue
        seg_text = segment_texts.get(r.segmentIndex, "")
        gs = grounding_score(r, seg_text)
        if gs < min_grounding:
            stats.dropped_not_grounded += 1
            continue
        if require_quote and not quote_grounded(r, seg_text):
            stats.dropped_not_grounded += 1
            continue
        r.confidence = round(gs, 3)
        kept.append(r)
    if dedup:
        before = len(kept)
        kept = deduplicate(kept, dedup_threshold)
        stats.dropped_dup = before - len(kept)
    kept = enforce_type_balance(kept, allowed_types, type_balance_mode)
    return kept, stats
```

#### T-6.5. Replicar en `web/lib/quality.ts`

Mismos algoritmos en TS. Poner `QualityStats` como parte del evento `pdf-end` en el stream (añadir campos opcionales en `StreamEvent` sin romper la UI existente).

---

### T-7. Suplemento dirigido

Reemplazar `_supplement_rows_if_needed` por `targeted_supplement`:

```python
def targeted_supplement(
    config: AppConfig,
    client: CompletionClient,
    segments: list[Segment],
    produced_by_segment: dict[int, int],
    target_per_segment: dict[int, int],
    max_attempts: int = 2,
) -> list[QARecord]:
    """Pide preguntas adicionales SOLO a los segmentos con déficit, hasta cerrar la meta.

    A diferencia del método combinado previo, mantiene trazabilidad por segmento
    y evita saturar el contexto del modelo.
    """
    extras: list[QARecord] = []
    for idx, target in target_per_segment.items():
        deficit = target - produced_by_segment.get(idx, 0)
        if deficit <= 0:
            continue
        segment = segments[idx]
        for attempt in range(max_attempts):
            try:
                rows = generate_qa_for_segment(client, config, segment, deficit)
                extras.extend(rows)
                if len(rows) >= deficit:
                    break
                deficit -= len(rows)
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Supplement attempt %d for seg %d failed: %s", attempt + 1, idx, exc)
    return extras
```

Mantener también el modo `combined` (legacy) detrás del flag `supplement_strategy`. Defaultear a `targeted`.

---

### T-8. Reintentos robustos y observabilidad

#### T-8.1. Backoff con jitter y clasificación de errores

```python
import random
import time


_PERMANENT_STATUS = {400, 401, 403, 404, 422}


def _is_transient(exc: BaseException) -> bool:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status not in _PERMANENT_STATUS
    return True  # errores de red/desconocidos: reintenta


def _sleep_backoff(attempt: int, base: float, jitter: float) -> None:
    delay = base * (2 ** (attempt - 1)) + random.uniform(0, jitter)
    time.sleep(delay)
```

Usarlos en `generate_qa_for_segment`. En TS, equivalente con `setTimeout`.

#### T-8.2. Logger estructurado

Añadir un `LOGGER.info` por llamada al LLM con: `pdf`, `segment`, `attempt`, `tokens_prompt_estimate`, `duration_ms`, `status`. En TS, emitir eventos `log` en el stream NDJSON (la UI puede ignorarlos; las pruebas los aprovechan).

#### T-8.3. Resumen por PDF

Al final de `process_pdf`, escribir un `*_qgen_meta.json` con: total generado, rechazados por stage, tipos de pregunta, dificultad, tiempo total, modelo, config hash. Esto habilita auditoría sin ejecutar de nuevo.

---

### T-9. Integración en `main.py` / `route.ts`

#### T-9.1. Python

```python
def process_pdf(config: AppConfig, client, pdf_path: Path) -> tuple[Path, Path]:
    LOGGER.info("Processing %s", pdf_path.name)
    segments = split_pdf_into_segments(
        pdf_path,
        pages_per_segment=config.pages_per_segment,
        strategy=config.segmentation_strategy,
        target_tokens=config.segment_target_tokens,
        max_tokens=config.segment_max_tokens,
        min_tokens=config.segment_min_tokens,
        overlap_tokens=config.segment_overlap_tokens,
    )
    allocations = allocate_questions_across_segments(
        segments, config.num_questions,
        strategy=config.allocation_strategy,
        min_per_segment=config.min_questions_per_segment,
        max_per_segment=config.max_questions_per_segment,
    )

    records: list[QARecord] = []
    produced_by_segment: dict[int, int] = {}
    for idx, segment in enumerate(segments):
        to_generate = allocations.get(idx, 0)
        if to_generate == 0:
            continue
        segment_rows = generate_qa_for_segment(client, config, segment, to_generate)
        records.extend(segment_rows)
        produced_by_segment[idx] = len(segment_rows)

    # Calidad por segmento antes del suplemento (cuenta más fielmente el déficit)
    segment_texts = {i: s.text for i, s in enumerate(segments)}
    records, stats = run_quality_pipeline(
        records, segment_texts,
        min_grounding=config.grounding_min_overlap,
        min_answer_words=config.min_answer_words,
        max_answer_words=config.max_answer_words,
        dedup=config.enable_dedup,
        dedup_threshold=config.dedup_similarity_threshold,
        require_quote=config.require_supporting_quote,
        allowed_types=config.question_types,
        type_balance_mode=config.question_types_balance,
    )
    LOGGER.info("Quality filter: %s", stats)

    # Recalcular produced_by_segment luego de filtros
    produced_by_segment = {}
    for r in records:
        produced_by_segment[r.segmentIndex] = produced_by_segment.get(r.segmentIndex, 0) + 1

    if len(records) < config.num_questions and config.supplement_strategy == "targeted":
        extras = targeted_supplement(
            config, client, segments,
            produced_by_segment=produced_by_segment,
            target_per_segment=allocations,
            max_attempts=config.supplement_max_attempts,
        )
        extras, _ = run_quality_pipeline(
            extras, segment_texts,
            min_grounding=config.grounding_min_overlap,
            min_answer_words=config.min_answer_words,
            max_answer_words=config.max_answer_words,
            dedup=config.enable_dedup,
            dedup_threshold=config.dedup_similarity_threshold,
            require_quote=config.require_supporting_quote,
            allowed_types=config.question_types,
            type_balance_mode="auto",  # no forzar equal en el suplemento
        )
        records.extend(extras)
    elif config.supplement_strategy == "combined":
        records = _supplement_combined_legacy(config, records, segments, client)

    # Recortar al objetivo (si hubo exceso)
    records = records[: config.num_questions]

    csv_path, xlsx_path = write_outputs_for_pdf(
        output_dir=config.output_path,
        pdf_stem=pdf_path.stem,
        records=records,
        include_metadata_columns=config.include_metadata_columns,
    )
    _write_run_meta(config, pdf_path, records, stats, csv_path.parent)
    return csv_path, xlsx_path
```

#### T-9.2. TS

Reescribir `web/app/api/generate/route.ts` con:
- `splitPdfIntoSegments(... {strategy, targetTokens, maxTokens, minTokens, overlapTokens})`
- `allocateQuestionsAcrossSegments(segments, total, {strategy, minPerSegment, maxPerSegment})`
- `runQualityPipeline(...)` en `lib/quality.ts`
- **Paralelismo acotado**: procesar hasta `maxConcurrentSegments` segmentos en paralelo con una semáforo simple (ver abajo):

```typescript
async function processWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function pull() {
    while (next < items.length) {
      const current = next++;
      results[current] = await worker(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, pull);
  await Promise.all(workers);
  return results;
}
```

Emitir eventos del stream con los mismos tipos que la UI ya conoce, añadiendo campos opcionales `quality?: { droppedNotGrounded, droppedDup, droppedLength }` en `pdf-end`.

---

### T-10. Configuración `config.yaml` actualizada

Reemplazar el archivo por:

```yaml
# --- Gateway --------------------------------------------------------
gateway_api_key_env: GW_GATEWAY_API_KEY
gateway_base_url_env: GW_BASE_URL
gateway_model_env: GW_CHAT_MODEL
model: gpt-4.1-mini

# --- I/O ------------------------------------------------------------
documents_dir: documents
output_dir: outputs
include_metadata_columns: true   # con heading y cita ayuda mucho al revisor

# --- Localización / dominio -----------------------------------------
locale: es-MX
domain_hint: >
  Documento regulatorio mexicano sobre el Sistema de Ahorro para el Retiro
  (SAR, CONSAR, AFORES, SIEFORES). Las siglas y nombres de órganos deben
  conservarse en su forma oficial.

# --- Segmentación ---------------------------------------------------
segmentation_strategy: semantic
pages_per_segment: 10            # usado solo como fallback
segment_target_tokens: 1200
segment_max_tokens: 2000
segment_min_tokens: 200
segment_overlap_tokens: 120

# --- Reparto --------------------------------------------------------
allocation_strategy: weighted
num_questions: 100
min_questions_per_segment: 0
max_questions_per_segment: 20

# --- Prompt / generación --------------------------------------------
question_instructions: >
  Genera reactivos prácticos y verificables que cubran definiciones, hechos
  clave, procedimientos, sanciones, plazos, obligaciones de las Afores y
  facultades de la CONSAR. Varía el tipo de pregunta.
difficulty: mixed
question_types:
  - factual
  - conceptual
  - procedural
  - application
  - reasoning
question_types_balance: auto
min_answer_words: 12
max_answer_words: 80
require_supporting_quote: true
json_mode: json_schema
temperature: 0.2
max_output_tokens: 4000

# --- Calidad --------------------------------------------------------
enable_grounding_check: true
grounding_min_overlap: 0.30
enable_dedup: true
dedup_similarity_threshold: 0.88
enable_answer_length_guard: true

# --- Suplemento -----------------------------------------------------
supplement_strategy: targeted
supplement_max_attempts: 2

# --- Robustez -------------------------------------------------------
retry_attempts: 4
retry_backoff_seconds: 1.5
retry_jitter_seconds: 1.0
max_concurrent_segments: 4
```

---

### T-11. Tests nuevos

Crear los siguientes archivos en `tests/`:

#### T-11.1. `test_structural_extractor.py`
- Genera con PyMuPDF un PDF en memoria con "TÍTULO PRIMERO", "Capítulo I", "Artículo 1." y texto normal.
- Verifica que `extract_structural` retorna bloques con `heading_kind` correcto.

#### T-11.2. `test_segmenter.py`
- Construye `StructuralPage` ficticios (sin PDF) y valida que `segment_by_structure` produce un segmento por artículo.
- Caso: artículo largo supera `max_tokens` → se subdivide en `parte 1`, `parte 2`.
- Caso: dos artículos muy cortos consecutivos → se fusionan.
- Caso: sin encabezados → retorna 0; `split_pdf_into_segments` debe caer a paginado.

#### T-11.3. `test_allocator_weighted.py`
- (Ver código en T-4.1.) Añadir casos extremos: un solo segmento con mucho texto; varios con cero tokens utilizables.

#### T-11.4. `test_quality.py`
- `grounding_score` con respuesta totalmente contenida → 1.0.
- `grounding_score` con respuesta inventada → < 0.1.
- `deduplicate` elimina preguntas con Jaccard alto.
- `enforce_type_balance` en modo `equal` corta excesos.

#### T-11.5. `test_question_generator_integration.py`
- Stub `CompletionClient` que devuelve JSON válido/ inválido/ parcial.
- Verifica degradación de `json_schema` → `json_object` → regex.
- Verifica validación Pydantic rechaza items con preguntas "según el texto...".

#### T-11.6. TS: `web/lib/__tests__/`
- Añadir Vitest o Node's built-in `node:test`. Mínimo replicar `allocator.test.ts`, `quality.test.ts`, `segmenter.test.ts`.
- Añadir a `package.json`:
  ```json
  "scripts": { ..., "test": "vitest run" },
  "devDependencies": { ..., "vitest": "^2.0.0", "zod": "^3.23.8" }
  ```

---

### T-12. Actualización de tests existentes

- `test_allocator.py`: añadir `token_estimate=len(text)//4` a cada `Segment` creado, si no, el reparto ponderado dará 0 tokens. O pasar `strategy="uniform"` para mantener el comportamiento previo en estos tests.
- `test_pdf_splitter.py`: ajustar monkeypatches para el nuevo extractor estructural. En lugar de `extract_page_texts_markdown` y `extract_page_texts_txt`, monkeypatch `extract_structural` devolviendo `StructuralPage(blocks=[PageBlock(...)])` ficticios.
- `test_question_parser.py`: renombrar a `test_json_extraction.py` y probar el nuevo parser robusto (schema → regex fallback).
- `test_llm_client.py`: sigue aplicable; verificar que el cliente también envía `messages` con role `system`.
- `test_openai_temperature_fallback.py`: sigue aplicable; agregar test equivalente para `_gateway_rejects_response_format`.
- `test_exporter.py`: verificar que nuevas columnas (`heading`, `questionType`, `difficulty`, `supportingQuote`) aparecen en XLSX/CSV **solo** si `include_metadata_columns=true`.

---

### T-13. Exporter: columnas enriquecidas

En `qgen/exporter.py`, cuando `include_metadata_columns=True`, añadir en este orden:

```
question, expectedResponse, supportingQuote, questionType, difficulty,
sourcePdf, heading, segmentIndex, pageStart, pageEnd, confidence
```

Cuando `False`, mantener solo `question, expectedResponse` para no romper consumidores viejos.

Mismo cambio en `web/lib/exporter.ts`.

---

### T-14. Docstring / documentación

Actualizar `README.md` con una sección nueva "Mejoras de calidad (v2)" que explique:
- Segmentación semántica por artículos.
- Reparto ponderado.
- `supportingQuote` y su uso en revisión.
- Nuevos parámetros en `config.yaml`.
- Cómo interpretar `*_qgen_meta.json`.

No borrar la sección antigua; marcarla como "Comportamiento legacy con `segmentation_strategy: pages`".

---

### T-15. Archivo `requirements.txt` y `package.json`

#### requirements.txt

Reemplazar por:

```
openai>=1.40.0
python-dotenv>=1.0.0
pypdf>=4.0.0
pymupdf>=1.24.0
pymupdf4llm>=0.0.17    # se mantiene como fallback opcional
pandas>=2.0.0
openpyxl>=3.1.0
PyYAML>=6.0
pydantic>=2.7.0
pytest>=8.0.0
```

#### web/package.json (dependencias nuevas)

```
"zod": "^3.23.8"
```

DevDependencies:

```
"vitest": "^2.0.0",
"@vitest/coverage-v8": "^2.0.0"
```

---

### T-16. Validación end-to-end (manual, no automatizable aquí)

Una vez terminadas T-1 .. T-15, Sonnet debe:

1. Ejecutar `pytest -q`: **debe pasar 100%**.
2. Si es posible en el entorno: correr `python -m qgen.main --config config.yaml` sobre `documents/LSAR.pdf` con `num_questions=20` (temporalmente) para humo. Revisar `outputs/LSAR_qgen.xlsx`:
   - Respuestas ≤ 80 palabras.
   - `supportingQuote` presente y aparece textualmente en el PDF.
   - Preguntas no empiezan con "Según el texto…".
   - Tipos de pregunta variados.
3. En la web: `cd web && npm run build` y `npm run test`. No ejecutar `npm run dev` (no hay PDFs cargados).

Reportar cualquier sección donde no se pudo cumplir T-16 con contexto y log.

---

## 5. Orden topológico sugerido de commits

1. `T-1`: modelos + config (no rompe nada, solo agrega).
2. `T-2`: extractor estructural (Python + TS) con tests.
3. `T-3`: segmentador (Python + TS) + reescritura de `pdf_splitter`.
4. `T-4`: allocator ponderado (Python + TS).
5. `T-5`: prompts + question_generator (Python + TS).
6. `T-6`: quality pipeline (Python + TS).
7. `T-7`: suplemento dirigido.
8. `T-8`: reintentos/observabilidad.
9. `T-9`: integración en `main.py` y `route.ts`.
10. `T-10`: `config.yaml` nuevo.
11. `T-11` + `T-12`: tests nuevos y actualizados.
12. `T-13`: exporter.
13. `T-14`: README.
14. `T-15`: dependencias.
15. `T-16`: validación final.

Un commit por cada ítem, mensaje imperativo en inglés, sin sentinelas de "Generated with...".

---

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| El gateway no soporta `response_format: json_schema` | Caer a `json_object` y luego a regex; la función `_gateway_rejects_response_format` ya lo maneja |
| El gateway no soporta `presence_penalty`/`frequency_penalty` | Bandera `_omit_penalty` análoga a `_omit_temperature` |
| PyMuPDF detecta tablas de forma inconsistente en PDFs regulatorios | `has_tables` es sólo un hint para el prompt; no afecta el flujo |
| Segmentación semántica falla (0 o 1 segmento) | Fallback automático a `segment_by_pages` con overlap |
| `supportingQuote` no encaja literal porque el PDF tiene guiones cortos vs. largos | Normalizar ambos lados (`–` → `-`, múltiples espacios → uno, NFC) antes de comparar |
| Vercel Hobby plan: 60s max | Mantener `max_concurrent_segments: 4` modesto; documentar en README que PDFs grandes requieren Pro |
| PDFs escaneados (sin texto) | Log warning + generar 0 preguntas; NO agregar OCR en este plan (scope control); futuro: ver nota abajo |

---

## 7. Fuera de alcance (deliberadamente)

- OCR de PDFs escaneados (añadiría `tesseract` + `pytesseract` y latencia fuerte). Sugerir en `README` evaluarlo si un PDF carece de texto extraíble.
- Embeddings para dedup semántica "de verdad". El Jaccard es suficiente para detectar duplicados casi literales, que son el 90% del problema.
- UI changes. Este plan deja la UI intacta; solo propagan los nuevos campos opcionales por los tipos TS.
- Evaluación con LLM-as-judge. Se podría agregar como paso de calidad opcional; fuera de alcance de v2.

---

## 8. Criterios de aceptación del plan

El plan se considera "completado" por Sonnet cuando:

1. Todos los tests (existentes y nuevos) pasan con `pytest -q` y `cd web && npm run test`.
2. Sobre `documents/LSAR.pdf` con `num_questions: 30`:
   - ≥ 90% de las preguntas tienen `supportingQuote` verificable literalmente en el PDF (check manual sobre 5 muestras).
   - 0 preguntas empiezan con "Según el texto…"/"De acuerdo con el texto…".
   - Hay al menos 3 tipos distintos de `questionType` representados.
   - Longitud de respuesta entre 12 y 80 palabras en el 100% de los casos.
   - `_qgen_meta.json` generado con `stats` correctas.
3. `config.yaml` legacy (el viejo formato) sigue cargando sin lanzar excepción, aunque con warnings de deprecación.
4. El stream NDJSON de `/api/generate` sigue emitiendo los mismos tipos de eventos que antes (la UI no requiere cambios para funcionar).

---

## 9. Apéndice: archivos nuevos y modificados

**Nuevos:**
- `qgen/extractors/__init__.py`
- `qgen/extractors/structural.py`
- `qgen/segmenter.py`
- `qgen/prompts.py`
- `qgen/quality.py`
- `tests/test_structural_extractor.py`
- `tests/test_segmenter.py`
- `tests/test_quality.py`
- `tests/test_question_generator_integration.py`
- `web/lib/extractors/structural.ts`
- `web/lib/segmenter.ts`
- `web/lib/prompts.ts`
- `web/lib/quality.ts`
- `web/lib/__tests__/allocator.test.ts`
- `web/lib/__tests__/quality.test.ts`
- `web/lib/__tests__/segmenter.test.ts`
- `opusplan1.md` (este documento)

**Modificados:**
- `qgen/__init__.py` (exportar nuevas clases si se exportan hoy)
- `qgen/models.py`
- `qgen/config.py`
- `qgen/pdf_splitter.py`
- `qgen/allocator.py`
- `qgen/question_generator.py`
- `qgen/main.py`
- `qgen/exporter.py`
- `config.yaml`
- `README.md`
- `requirements.txt`
- `tests/test_allocator.py`
- `tests/test_pdf_splitter.py`
- `tests/test_question_parser.py` → `tests/test_json_extraction.py`
- `tests/test_llm_client.py`
- `tests/test_openai_temperature_fallback.py`
- `tests/test_exporter.py`
- `web/lib/types.ts`
- `web/lib/pdfSplitter.ts`
- `web/lib/allocator.ts`
- `web/lib/questionGenerator.ts`
- `web/lib/gateway.ts`
- `web/lib/exporter.ts`
- `web/app/api/generate/route.ts`
- `web/package.json`

**Intocables (scope lock — no modificar):**
- `web/app/page.tsx`
- `web/app/layout.tsx`
- `web/app/globals.css`
- `web/components/*`
- `archive/*`

---

*Fin del OpusPlan1.*

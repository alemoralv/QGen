# QGen — Generador de preguntas desde PDF

Herramienta que ofrece dos vías de uso:

- **CLI Python**: lee PDFs con texto extraíble, los divide en segmentos y genera preguntas/respuestas vía gateway LLM.
- **Web UI (Next.js)**: flujo visual por pasos para cargar PDFs, configurar generación, ver progreso en streaming y exportar CSV/XLSX.

## ¿Qué hace el sistema?

1. **Entrada**: toma todos los archivos `.pdf` que estén en la carpeta configurada (`documents_dir`, normalmente `documents/`).
2. **Extracción de texto**: usa `pypdf` para sacar el texto de cada página. **No incluye OCR**; si el PDF es escaneado o casi sin texto, habrá poco o ningún contenido útil.
3. **Segmentación**: agrupa las páginas en bloques de `pages_per_segment` páginas consecutivas y arma objetos `Segment` (nombre del PDF, índice del segmento, rango de páginas, texto unido).
4. **Reparto de preguntas**: el módulo `allocator` reparte `num_questions` entre los segmentos que **sí tienen texto**; la distribución es lo más uniforme posible (parte entera + el sobrante se reparte a los primeros segmentos activos).
5. **Generación con LLM**: por cada segmento con asignación > 0, se envía un prompt que pide **exactamente** ese número de pares pregunta–respuesta en **JSON** (sin markdown), con las claves `question` y `expectedResponse`. El idioma de salida debe coincidir con el del fragmento de texto.
6. **Reintentos**: si falla el parseo o la llamada, reintenta hasta `retry_attempts` con espera creciente (`retry_backoff_seconds`).
7. **Completar filas**: si al final faltan filas respecto a `num_questions`, intenta un **último paso** concatenando el texto de todos los segmentos no vacíos y pidiendo las que falten.
8. **Exportación**: escribe, por cada PDF de origen, un **CSV** y un **XLSX** en `output_dir` (por defecto `outputs/`), con nombres `<nombre_del_pdf>_qgen.csv` y `.xlsx`.

### Columnas del archivo de salida

Siempre incluye:

- `question`
- `expectedResponse`

Opcionalmente (si `include_metadata_columns: true` en `config.yaml`):

- `sourcePdf`, `segmentIndex`, `pageStart`, `pageEnd`

### Proveedor de modelo

Todas las llamadas al LLM pasan por un **gateway compatible con OpenAI** (Azure Container Apps). El cliente usa el SDK oficial de OpenAI pero apuntando al `base_url` del gateway, y envía las peticiones al endpoint `chat/completions`.

- `GW_BASE_URL`: URL pública del gateway (sin barra final).
- `GW_CHAT_MODEL`: id del modelo servido por el gateway (p. ej. `gpt-4.1-mini`).
- `GW_GATEWAY_API_KEY`: tu llave personal (usualmente empieza con `gw_`).

Si el modelo **no acepta** el parámetro `temperature`, el código lo omite automáticamente en un segundo intento.

La carga de variables desde un archivo `.env` en la raíz del proyecto requiere `python-dotenv` (ya está en `requirements.txt`).

## Requisitos

- Python 3.10 o superior.
- Llave del gateway (`GW_GATEWAY_API_KEY`) y URL base (`GW_BASE_URL`).
- PDFs con **texto seleccionable** (no se hace OCR en esta versión).

## Instalación

```bash
cd ruta/al/proyecto
pip install -r requirements.txt
```

## Configuración de claves (sin subirlas al repositorio)

1. Copia `.env.example` a `.env` en la raíz del proyecto.
2. Rellena `GW_BASE_URL`, `GW_CHAT_MODEL` y `GW_GATEWAY_API_KEY` (tu llave `gw_...`).

**No subas** `.env` ni PDFs confidenciales: en este repositorio, `documents/` y `.env` están en `.gitignore`.

## Ejecución

Coloca tus PDFs en la carpeta local `documents/` (esa carpeta no se versiona).

```bash
python -m qgen.main --config config.yaml
```

Por defecto, `--config` apunta a `config.yaml` en el directorio actual.

## Opciones en `config.yaml`

| Clave | Descripción |
|--------|-------------|
| `gateway_api_key_env` | Nombre de la variable de entorno con la llave del gateway (por defecto `GW_GATEWAY_API_KEY`). |
| `gateway_base_url_env` | Nombre de la variable con la URL base del gateway (por defecto `GW_BASE_URL`). |
| `gateway_model_env` | Nombre de la variable con el id del modelo (por defecto `GW_CHAT_MODEL`). |
| `model` | Modelo por defecto si `GW_CHAT_MODEL` no está definido. |
| `documents_dir` | Carpeta donde están los PDF de entrada. |
| `output_dir` | Carpeta de salida CSV/XLSX. |
| `pages_per_segment` | Páginas por segmento (por defecto `10`). |
| `num_questions` | Total de preguntas objetivo **por PDF completo**. |
| `question_instructions` | Instrucciones en lenguaje natural para el estilo y foco de las preguntas. |
| `difficulty` | `basic`, `mixed` o `advanced`. |
| `temperature` | Temperatura del modelo (0–2; algunos modelos del gateway pueden ignorarla). |
| `max_output_tokens` | Límite de tokens de salida. |
| `include_metadata_columns` | `true` para añadir columnas de trazabilidad al CSV/XLSX. |
| `retry_attempts` | Número de reintentos por segmento. |
| `retry_backoff_seconds` | Base de espera entre reintentos (se escala por intento). |

## Estructura del código (paquete `qgen`)

- `main.py`: orquesta lectura de PDFs, generación y exportación; CLI con `--config`.
- `config.py`: carga YAML, validación y rutas; integración con `.env`.
- `pdf_splitter.py`: extracción de texto por página y construcción de `Segment`.
- `allocator.py`: reparto de `num_questions` entre segmentos con texto.
- `question_generator.py`: prompt, cliente gateway (OpenAI-compatible), parseo JSON y reintentos.
- `exporter.py`: escritura con pandas a CSV y Excel.
- `models.py`: dataclasses `Segment` y `QARecord`.

## Pruebas

```bash
pytest -q
```

## Web UI (Next.js + Vercel)

La UI vive en `web/` y usa la ruta `web/app/api/generate/route.ts` para procesar PDFs en streaming (NDJSON).

```bash
cd web
npm install
npm run dev
```

Variables para `web/.env.local` (desarrollo) y Vercel Project Env (producción):

- `GW_BASE_URL` (requerido en servidor)
- `GW_CHAT_MODEL` (opcional, default `gpt-4.1-mini`)

La llave `gw_...` **no** se guarda en servidor: se introduce en la UI y se envía por request header `x-gw-api-key`.

## Limitaciones

- PDFs basados en imagen u OCR no soportados aquí: el volumen de preguntas puede ser menor que `num_questions` si hay poco texto extraíble.
- La calidad depende del modelo y del contenido del PDF.

## Licencia y uso

Revisa las condiciones de uso de tu gateway/modelo antes de procesar documentos con datos personales o confidenciales.

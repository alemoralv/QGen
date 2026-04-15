import { NextRequest } from "next/server";
import { allocateQuestionsAcrossSegments } from "@/lib/allocator";
import { buildGatewayClient } from "@/lib/gateway";
import { splitPdfIntoSegments } from "@/lib/pdfSplitter";
import { QuestionGenerator } from "@/lib/questionGenerator";
import type { GenerationConfig, Segment, StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300; // seconds, Vercel Pro default ceiling

function jsonLine(event: StreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function parseConfig(raw: unknown): GenerationConfig {
  const r = (raw ?? {}) as Partial<GenerationConfig>;
  const numQuestions = Math.max(1, Math.floor(Number(r.numQuestions ?? 20)));
  const pagesPerSegment = Math.max(
    1,
    Math.floor(Number(r.pagesPerSegment ?? 10))
  );
  const temperature = Math.max(0, Math.min(2, Number(r.temperature ?? 0.2)));
  const maxOutputTokens = Math.max(
    256,
    Math.min(16000, Math.floor(Number(r.maxOutputTokens ?? 4000)))
  );
  const difficulty =
    r.difficulty === "basic" || r.difficulty === "advanced"
      ? r.difficulty
      : "mixed";
  const questionInstructions =
    (r.questionInstructions && String(r.questionInstructions).trim()) ||
    "Genera preguntas prácticas de comprensión que cubran hechos clave, definiciones, procedimientos y detalles importantes del texto.";
  return {
    numQuestions,
    pagesPerSegment,
    difficulty,
    temperature,
    maxOutputTokens,
    questionInstructions,
  };
}

async function supplementIfNeeded(
  generator: QuestionGenerator,
  config: GenerationConfig,
  segments: Segment[],
  producedSoFar: number,
  pushRow: (rec: import("@/lib/types").QARecord) => void
) {
  const missing = config.numQuestions - producedSoFar;
  if (missing <= 0) return;
  const nonEmpty = segments.filter((s) => s.text.trim().length > 0);
  if (nonEmpty.length === 0) return;
  const combined: Segment = {
    sourcePdf: nonEmpty[0].sourcePdf,
    segmentIndex: 9999,
    pageStart: nonEmpty[0].pageStart,
    pageEnd: nonEmpty[nonEmpty.length - 1].pageEnd,
    text: nonEmpty.map((s) => s.text).join("\n\n"),
  };
  try {
    const extra = await generator.generate(combined, missing);
    for (const rec of extra) pushRow(rec);
  } catch {
    // Swallow: we already have partial results to return.
  }
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-gw-api-key")?.trim() ?? "";
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Falta la llave del gateway (x-gw-api-key)." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const baseUrl = (process.env.GW_BASE_URL ?? "").trim();
  const model = (process.env.GW_CHAT_MODEL ?? "gpt-4.1-mini").trim();
  if (!baseUrl) {
    return new Response(
      JSON.stringify({
        error: "GW_BASE_URL no está configurado en el servidor.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response(
      JSON.stringify({ error: "No se pudo leer el formulario." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const configField = formData.get("config");
  let genConfig: GenerationConfig;
  try {
    genConfig = parseConfig(
      configField ? JSON.parse(String(configField)) : {}
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "Config inválida." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return new Response(
      JSON.stringify({ error: "No se subió ningún PDF." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const client = buildGatewayClient({ apiKey, baseUrl });
  const generator = new QuestionGenerator(client, model, genConfig);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: StreamEvent) => controller.enqueue(jsonLine(event));

      // Prefetch page counts per PDF so the UI can show totals right away.
      const parsed: {
        name: string;
        segments: Segment[];
        pageCount: number;
      }[] = [];
      try {
        for (const file of files) {
          const buf = new Uint8Array(await file.arrayBuffer());
          const { segments, pageCount } = await splitPdfIntoSegments(
            file.name,
            buf,
            genConfig.pagesPerSegment
          );
          parsed.push({ name: file.name, segments, pageCount });
        }
      } catch (err) {
        emit({
          type: "error",
          message:
            err instanceof Error
              ? `Error al leer PDF: ${err.message}`
              : "Error desconocido al leer PDF",
        });
        controller.close();
        return;
      }

      emit({
        type: "meta",
        totalPdfs: parsed.length,
        pdfs: parsed.map((p) => ({ name: p.name, pages: p.pageCount })),
      });

      let grandTotal = 0;

      for (const { name, segments, pageCount } of parsed) {
        emit({
          type: "pdf-start",
          pdf: name,
          segments: segments.length,
          pages: pageCount,
        });

        let perPdfRows = 0;
        const emittedSegmentRows: import("@/lib/types").QARecord[] = [];
        const pushRow = (rec: import("@/lib/types").QARecord) => {
          perPdfRows += 1;
          grandTotal += 1;
          emittedSegmentRows.push(rec);
          emit({ type: "row", pdf: name, record: rec });
        };

        let allocations: Map<number, number>;
        try {
          allocations = allocateQuestionsAcrossSegments(
            segments,
            genConfig.numQuestions
          );
        } catch (err) {
          emit({
            type: "error",
            pdf: name,
            message:
              err instanceof Error ? err.message : "Error de asignación",
          });
          emit({ type: "pdf-end", pdf: name, totalRows: perPdfRows });
          continue;
        }

        for (let i = 0; i < segments.length; i += 1) {
          const segment = segments[i];
          const expected = allocations.get(i) ?? 0;
          if (expected === 0) continue;
          try {
            const rows = await generator.generate(segment, expected);
            for (const r of rows) pushRow(r);
            emit({
              type: "segment-progress",
              pdf: name,
              segmentIndex: i,
              produced: rows.length,
              expected,
            });
          } catch (err) {
            emit({
              type: "error",
              pdf: name,
              message:
                err instanceof Error
                  ? `Segmento ${i}: ${err.message}`
                  : `Segmento ${i}: error desconocido`,
            });
          }
        }

        if (perPdfRows < genConfig.numQuestions) {
          await supplementIfNeeded(
            generator,
            genConfig,
            segments,
            perPdfRows,
            pushRow
          );
        }

        emit({ type: "pdf-end", pdf: name, totalRows: perPdfRows });
      }

      emit({ type: "done", totalRows: grandTotal });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

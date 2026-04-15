"use client";

import { useEffect, useMemo, useState } from "react";
import Footer from "@/components/Footer";
import GenerationConfigForm from "@/components/GenerationConfig";
import GatewayKeyGate from "@/components/GatewayKeyGate";
import Header from "@/components/Header";
import PdfUploader from "@/components/PdfUploader";
import ProgressBar from "@/components/ProgressBar";
import ResultsTable from "@/components/ResultsTable";
import type { GenerationConfig, QARecord, StreamEvent } from "@/lib/types";

type AppState = "gate" | "upload" | "configure" | "generating" | "results";

interface PdfProgress {
  pages: number;
  totalSegments: number;
  completedSegments: number;
  rows: number;
  done: boolean;
}

const DEFAULT_CONFIG: GenerationConfig = {
  numQuestions: 20,
  pagesPerSegment: 10,
  difficulty: "mixed",
  temperature: 0.2,
  maxOutputTokens: 4000,
  questionInstructions:
    "Genera preguntas prácticas de comprensión que cubran hechos clave, definiciones, procedimientos y detalles importantes del texto.",
};

const GW_STORAGE_KEY = "qgen.gateway.key";

function withFallback<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function parseNdjsonChunk(
  chunk: string,
  onEvent: (event: StreamEvent) => void,
  carry: string
): string {
  const text = carry + chunk;
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as StreamEvent;
      onEvent(event);
    } catch {
      // Ignore malformed line and continue processing others.
    }
  }
  return rest;
}

export default function HomePage() {
  const [appState, setAppState] = useState<AppState>("gate");
  const [gatewayKey, setGatewayKey] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [config, setConfig] = useState<GenerationConfig>(DEFAULT_CONFIG);
  const [recordsByPdf, setRecordsByPdf] = useState<Record<string, QARecord[]>>({});
  const [progressByPdf, setProgressByPdf] = useState<Record<string, PdfProgress>>(
    {}
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const saved = sessionStorage.getItem(GW_STORAGE_KEY)?.trim() ?? "";
    if (!saved) return;
    setGatewayKey(saved);
    setAppState("upload");
  }, []);

  const overallProgress = useMemo(() => {
    const items = Object.values(progressByPdf);
    if (items.length === 0) return { value: 0, total: 1 };
    const value = items.reduce((sum, p) => sum + p.completedSegments, 0);
    const total = items.reduce((sum, p) => sum + Math.max(1, p.totalSegments), 0);
    return { value, total: Math.max(1, total) };
  }, [progressByPdf]);

  const handleGatewaySubmit = (key: string) => {
    setGatewayKey(key);
    sessionStorage.setItem(GW_STORAGE_KEY, key);
    setAppState("upload");
  };

  const handleReset = () => {
    setFiles([]);
    setRecordsByPdf({});
    setProgressByPdf({});
    setErrors([]);
    setIsRunning(false);
    setAppState("upload");
  };

  useEffect(() => {
    if (appState !== "generating" || isRunning) return;
    if (!gatewayKey || files.length === 0) return;

    const controller = new AbortController();
    const run = async () => {
      setIsRunning(true);
      setErrors([]);
      setRecordsByPdf({});
      setProgressByPdf({});

      try {
        const form = new FormData();
        for (const file of files) form.append("files", file);
        form.append("config", JSON.stringify(config));

        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "x-gw-api-key": gatewayKey },
          body: form,
          signal: controller.signal,
        });

        if (!response.ok) {
          const message =
            (await response.json().catch(() => ({} as { error?: string })))
              ?.error ?? `Error HTTP ${response.status}`;
          throw new Error(message);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No se pudo abrir el stream de respuesta.");
        const decoder = new TextDecoder();
        let carry = "";

        const consumeEvent = (event: StreamEvent) => {
          if (event.type === "meta") {
            setProgressByPdf((prev) => {
              const next = { ...prev };
              for (const pdf of event.pdfs) {
                next[pdf.name] = withFallback(next[pdf.name], {
                  pages: pdf.pages,
                  totalSegments: 1,
                  completedSegments: 0,
                  rows: 0,
                  done: false,
                });
              }
              return next;
            });
            return;
          }

          if (event.type === "pdf-start") {
            setProgressByPdf((prev) => ({
              ...prev,
              [event.pdf]: {
                pages: event.pages,
                totalSegments: Math.max(1, event.segments),
                completedSegments: 0,
                rows: 0,
                done: false,
              },
            }));
            return;
          }

          if (event.type === "segment-progress") {
            setProgressByPdf((prev) => {
              const current = prev[event.pdf];
              if (!current) return prev;
              return {
                ...prev,
                [event.pdf]: {
                  ...current,
                  completedSegments: Math.min(
                    current.totalSegments,
                    current.completedSegments + 1
                  ),
                },
              };
            });
            return;
          }

          if (event.type === "row") {
            setRecordsByPdf((prev) => ({
              ...prev,
              [event.pdf]: [...(prev[event.pdf] ?? []), event.record],
            }));
            setProgressByPdf((prev) => {
              const current = prev[event.pdf];
              if (!current) return prev;
              return {
                ...prev,
                [event.pdf]: { ...current, rows: current.rows + 1 },
              };
            });
            return;
          }

          if (event.type === "pdf-end") {
            setProgressByPdf((prev) => {
              const current = prev[event.pdf];
              if (!current) return prev;
              return {
                ...prev,
                [event.pdf]: {
                  ...current,
                  rows: event.totalRows,
                  completedSegments: current.totalSegments,
                  done: true,
                },
              };
            });
            return;
          }

          if (event.type === "error") {
            setErrors((prev) => [...prev, event.message]);
            return;
          }

          if (event.type === "done") {
            setAppState("results");
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          carry = parseNdjsonChunk(decoder.decode(value, { stream: true }), consumeEvent, carry);
        }
        const flush = decoder.decode();
        if (flush) carry = parseNdjsonChunk(flush, consumeEvent, carry);
        if (carry.trim()) {
          try {
            consumeEvent(JSON.parse(carry.trim()) as StreamEvent);
          } catch {
            // Ignore trailing malformed data.
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setErrors((prev) => [
          ...prev,
          err instanceof Error ? err.message : "Error desconocido",
        ]);
      } finally {
        setIsRunning(false);
      }
    };

    void run();
    return () => controller.abort();
  }, [appState, config, files, gatewayKey, isRunning]);

  return (
    <main className="min-h-screen">
      <Header />

      {appState === "gate" ? (
        <GatewayKeyGate onSubmit={handleGatewaySubmit} />
      ) : null}

      {appState === "upload" ? (
        <PdfUploader
          files={files}
          onChange={setFiles}
          onNext={() => setAppState("configure")}
        />
      ) : null}

      {appState === "configure" ? (
        <GenerationConfigForm
          value={config}
          onChange={setConfig}
          onBack={() => setAppState("upload")}
          onStart={() => setAppState("generating")}
        />
      ) : null}

      {appState === "generating" ? (
        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="mb-6 text-center">
            <span className="pill mb-4">Paso 4 de 5</span>
            <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
              Generando preguntas
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Estamos procesando tus PDFs y transmitiendo filas en tiempo real.
            </p>
          </div>

          <div className="card space-y-4">
            <ProgressBar
              label="Progreso global"
              value={overallProgress.value}
              total={overallProgress.total}
              hint={`${Object.keys(progressByPdf).length} PDF(s) en proceso`}
            />
            {Object.entries(progressByPdf).map(([pdf, progress]) => (
              <ProgressBar
                key={pdf}
                label={pdf}
                value={progress.completedSegments}
                total={Math.max(1, progress.totalSegments)}
                hint={`${progress.rows} fila(s) generadas${
                  progress.pages ? ` · ${progress.pages} pág.` : ""
                }`}
              />
            ))}

            {errors.length > 0 ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                <p className="font-semibold">Se detectaron incidencias:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {errors.map((msg, idx) => (
                    <li key={`${msg}-${idx}`}>{msg}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {!isRunning && Object.keys(recordsByPdf).length > 0 ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setAppState("results")}
                >
                  Ver resultados
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {appState === "results" ? (
        <ResultsTable recordsByPdf={recordsByPdf} onReset={handleReset} />
      ) : null}

      <Footer />
    </main>
  );
}

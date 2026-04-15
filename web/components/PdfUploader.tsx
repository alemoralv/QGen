"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface FilePreview {
  file: File;
  pageEstimate: number | null;
}

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  onNext: () => void;
}

function looksLikePdf(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

async function estimatePdfPages(file: File): Promise<number | null> {
  try {
    const buffer = await file.arrayBuffer();
    const text = new TextDecoder("latin1").decode(new Uint8Array(buffer));
    const matches = text.match(/\/Type\s*\/Page(?!s)\b/g);
    if (!matches || matches.length === 0) return null;
    return matches.length;
  } catch {
    return null;
  }
}

export default function PdfUploader({ files, onChange, onNext }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [estimates, setEstimates] = useState<Record<string, number | null>>({});

  const setNewFiles = useCallback(
    (incoming: File[]) => {
      const valid = incoming.filter(looksLikePdf);
      if (valid.length === 0) return;
      const merged = [...files];
      for (const f of valid) {
        const exists = merged.some(
          (curr) =>
            curr.name === f.name &&
            curr.size === f.size &&
            curr.lastModified === f.lastModified
        );
        if (!exists) merged.push(f);
      }
      onChange(merged);
    },
    [files, onChange]
  );

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const pending = files.filter((f) => !(f.name in estimates));
      for (const file of pending) {
        const pageEstimate = await estimatePdfPages(file);
        if (cancelled) return;
        setEstimates((prev) => ({ ...prev, [file.name]: pageEstimate }));
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [files, estimates]);

  const previews = useMemo<FilePreview[]>(
    () =>
      files.map((file) => ({
        file,
        pageEstimate: estimates[file.name] ?? null,
      })),
    [estimates, files]
  );

  return (
    <section className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 text-center">
        <span className="pill mb-4">Paso 2 de 5</span>
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          Sube tus PDFs
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Arrastra uno o varios archivos PDF. QGen procesa cada documento de
          forma independiente y genera su propio set de preguntas.
        </p>
      </div>

      <div className="card">
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            setNewFiles(Array.from(e.dataTransfer.files));
          }}
          className={[
            "rounded-2xl border-2 border-dashed p-8 text-center transition",
            dragActive
              ? "border-brand-500 bg-brand-50"
              : "border-slate-300 bg-white/50",
          ].join(" ")}
        >
          <p className="text-sm text-slate-700">
            Arrastra archivos aquí o selecciónalos manualmente.
          </p>
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => inputRef.current?.click()}
          >
            Seleccionar archivos
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              const incoming = e.target.files ? Array.from(e.target.files) : [];
              setNewFiles(incoming);
              e.currentTarget.value = "";
            }}
          />
        </div>

        {previews.length > 0 ? (
          <div className="mt-6 space-y-3">
            {previews.map(({ file, pageEstimate }) => (
              <div
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <p className="text-sm font-semibold text-slate-900">{file.name}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Páginas estimadas:{" "}
                  <span className="font-medium text-slate-800">
                    {pageEstimate ?? "detectando..."}
                  </span>
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            className="btn-secondary"
            disabled={files.length === 0}
            onClick={() => onChange([])}
          >
            Limpiar lista
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={files.length === 0}
            onClick={onNext}
          >
            Continuar
          </button>
        </div>
      </div>
    </section>
  );
}

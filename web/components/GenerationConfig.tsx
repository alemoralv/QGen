"use client";

import type { Difficulty, GenerationConfig } from "@/lib/types";

interface Props {
  value: GenerationConfig;
  onChange: (next: GenerationConfig) => void;
  onBack: () => void;
  onStart: () => void;
}

function difficultyLabel(value: Difficulty): string {
  if (value === "basic") return "Básica";
  if (value === "advanced") return "Avanzada";
  return "Mixta";
}

export default function GenerationConfigForm({
  value,
  onChange,
  onBack,
  onStart,
}: Props) {
  return (
    <section className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 text-center">
        <span className="pill mb-4">Paso 3 de 5</span>
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          Configura la generación
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Ajusta granularidad, dificultad y estilo para personalizar el banco de
          preguntas.
        </p>
      </div>

      <div className="card space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <label>
            <span className="label">Preguntas por PDF</span>
            <input
              className="input"
              type="number"
              min={1}
              max={500}
              value={value.numQuestions}
              onChange={(e) =>
                onChange({
                  ...value,
                  numQuestions: Math.max(1, Number(e.target.value) || 1),
                })
              }
            />
          </label>

          <label>
            <span className="label">Páginas por segmento</span>
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={value.pagesPerSegment}
              onChange={(e) =>
                onChange({
                  ...value,
                  pagesPerSegment: Math.max(1, Number(e.target.value) || 1),
                })
              }
            />
          </label>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <label>
            <span className="label">Temperatura ({value.temperature.toFixed(2)})</span>
            <input
              className="w-full accent-brand-600"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={value.temperature}
              onChange={(e) =>
                onChange({ ...value, temperature: Number(e.target.value) })
              }
            />
          </label>

          <label>
            <span className="label">Máx. tokens de salida</span>
            <input
              className="input"
              type="number"
              min={256}
              max={16000}
              value={value.maxOutputTokens}
              onChange={(e) =>
                onChange({
                  ...value,
                  maxOutputTokens: Math.min(
                    16000,
                    Math.max(256, Number(e.target.value) || 256)
                  ),
                })
              }
            />
          </label>
        </div>

        <fieldset>
          <legend className="label">Dificultad ({difficultyLabel(value.difficulty)})</legend>
          <div className="flex flex-wrap gap-2">
            {(["basic", "mixed", "advanced"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => onChange({ ...value, difficulty: opt })}
                className={[
                  "rounded-full px-4 py-2 text-sm font-medium ring-1 ring-inset transition",
                  value.difficulty === opt
                    ? "bg-brand-600 text-white ring-brand-600"
                    : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50",
                ].join(" ")}
              >
                {difficultyLabel(opt)}
              </button>
            ))}
          </div>
        </fieldset>

        <label>
          <span className="label">Instrucciones para las preguntas</span>
          <textarea
            className="input min-h-32 resize-y"
            value={value.questionInstructions}
            onChange={(e) =>
              onChange({ ...value, questionInstructions: e.target.value })
            }
          />
        </label>

        <div className="flex items-center justify-between gap-3">
          <button type="button" className="btn-secondary" onClick={onBack}>
            Volver
          </button>
          <button type="button" className="btn-primary" onClick={onStart}>
            Iniciar generación
          </button>
        </div>
      </div>
    </section>
  );
}

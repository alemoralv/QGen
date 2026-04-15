"use client";

import { useState } from "react";

interface Props {
  onSubmit: (key: string) => void;
}

export default function GatewayKeyGate({ onSubmit }: Props) {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [touched, setTouched] = useState(false);

  const looksValid = key.trim().startsWith("gw_") && key.trim().length > 8;
  const showError = touched && !looksValid;

  return (
    <section className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-6 text-center">
        <span className="pill mb-4">Paso 1 de 5</span>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Bienvenido a QGen
        </h1>
        <p className="mt-3 text-base text-slate-600">
          Pega tu llave del gateway para empezar a generar preguntas desde tus
          PDFs. La llave se queda en tu navegador y solo se envía al gateway
          cuando procesamos tu documento.
        </p>
      </div>

      <div className="card">
        <label className="label" htmlFor="gw-key">
          Llave del gateway
        </label>
        <div className="relative">
          <input
            id="gw-key"
            className="input pr-24 font-mono"
            placeholder="gw_••••••••••••••••"
            type={reveal ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => setTouched(true)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute inset-y-0 right-2 my-1.5 rounded-lg px-3 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            {reveal ? "Ocultar" : "Mostrar"}
          </button>
        </div>
        {showError ? (
          <p className="mt-2 text-xs text-rose-600">
            La llave debe comenzar con <code>gw_</code>.
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            Solicita tu llave al administrador del gateway si aún no tienes una.
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            className="btn-primary"
            disabled={!looksValid}
            onClick={() => onSubmit(key.trim())}
          >
            Continuar
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-brand-100 bg-brand-50/60 p-4 text-sm text-brand-900">
        <p className="font-semibold">Cómo funciona</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-brand-900/90">
          <li>Ingresas tu llave <code>gw_…</code>.</li>
          <li>Subes uno o varios PDFs con texto extraíble.</li>
          <li>
            Ajustas el número de preguntas y descargas los resultados en CSV o
            XLSX.
          </li>
        </ol>
      </div>
    </section>
  );
}

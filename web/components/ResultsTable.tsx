"use client";

import { useMemo, useState } from "react";
import { downloadCsv, downloadXlsx } from "@/lib/exporter";
import type { QARecord } from "@/lib/types";

interface Props {
  recordsByPdf: Record<string, QARecord[]>;
  onReset: () => void;
}

export default function ResultsTable({ recordsByPdf, onReset }: Props) {
  const pdfNames = useMemo(() => Object.keys(recordsByPdf), [recordsByPdf]);
  const [selectedPdf, setSelectedPdf] = useState<string>(pdfNames[0] ?? "");
  const [query, setQuery] = useState("");

  const selectedRecords = useMemo(
    () => recordsByPdf[selectedPdf] ?? [],
    [recordsByPdf, selectedPdf]
  );
  const filteredRecords = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return selectedRecords;
    return selectedRecords.filter(
      (r) =>
        r.question.toLowerCase().includes(q) ||
        r.expectedResponse.toLowerCase().includes(q)
    );
  }, [query, selectedRecords]);

  return (
    <section className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="pill mb-3">Paso 5 de 5</span>
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            Resultados listos
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Revisa las preguntas generadas y exporta en CSV o XLSX.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={onReset}>
          Generar otro
        </button>
      </div>

      <div className="card space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1">
            <span className="label">Documento</span>
            <select
              className="input"
              value={selectedPdf}
              onChange={(e) => setSelectedPdf(e.target.value)}
            >
              {pdfNames.map((pdf) => (
                <option key={pdf} value={pdf}>
                  {pdf} ({recordsByPdf[pdf].length} filas)
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-64 flex-[2]">
            <span className="label">Filtrar por texto</span>
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar en pregunta o respuesta"
            />
          </label>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => downloadCsv(selectedPdf, selectedRecords, false)}
            disabled={!selectedPdf || selectedRecords.length === 0}
          >
            Descargar CSV
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => downloadXlsx(selectedPdf, selectedRecords, false)}
            disabled={!selectedPdf || selectedRecords.length === 0}
          >
            Descargar XLSX
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-3">Pregunta</th>
                <th className="px-4 py-3">Respuesta esperada</th>
                <th className="px-4 py-3">Páginas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRecords.map((row, idx) => (
                <tr key={`${selectedPdf}-${idx}`}>
                  <td className="px-4 py-3 align-top text-slate-900">
                    {row.question}
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">
                    {row.expectedResponse}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-top text-slate-500">
                    {row.pageStart}-{row.pageEnd}
                  </td>
                </tr>
              ))}
              {filteredRecords.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-8 text-center text-sm text-slate-500"
                  >
                    No hay filas para mostrar con ese filtro.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

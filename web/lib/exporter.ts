import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { QARecord } from "./types";

function sanitizeBaseName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^/.]+$/, "");
  return withoutExt.replace(/[^a-zA-Z0-9._-]/g, "_") || "dataset";
}

function recordsToRows(records: QARecord[], includeMetadata: boolean) {
  return records.map((r) => {
    const row: Record<string, string | number> = {
      question: r.question,
      expectedResponse: r.expectedResponse,
    };
    if (includeMetadata) {
      row.sourcePdf = r.sourcePdf;
      row.segmentIndex = r.segmentIndex;
      row.pageStart = r.pageStart;
      row.pageEnd = r.pageEnd;
    }
    return row;
  });
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(
  pdfName: string,
  records: QARecord[],
  includeMetadata = false
) {
  const rows = recordsToRows(records, includeMetadata);
  const csv = Papa.unparse(rows, { quotes: true });
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  triggerBrowserDownload(blob, `${sanitizeBaseName(pdfName)}_qgen.csv`);
}

export function downloadXlsx(
  pdfName: string,
  records: QARecord[],
  includeMetadata = false
) {
  const rows = recordsToRows(records, includeMetadata);
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "QGen");
  const wbout = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerBrowserDownload(blob, `${sanitizeBaseName(pdfName)}_qgen.xlsx`);
}

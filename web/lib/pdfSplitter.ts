import type { Segment } from "./types";

// Dynamic import so Next.js can tree-shake the client bundle and so the worker
// entry is only required at runtime on the Node side of the API route.
async function loadPdfjs() {
  // Legacy build is the Node-friendly distribution.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Disable worker: run on the Node thread.
  // @ts-expect-error - GlobalWorkerOptions exists at runtime
  pdfjs.GlobalWorkerOptions.workerSrc = false;
  return pdfjs;
}

export async function extractPageTexts(buffer: Uint8Array): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: buffer,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: { str?: string }) => (typeof item.str === "string" ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(text);
  }
  await doc.destroy();
  return pages;
}

export function buildSegmentsFromPageTexts(
  sourcePdf: string,
  pageTexts: string[],
  pagesPerSegment: number
): Segment[] {
  if (pagesPerSegment <= 0) {
    throw new Error("pagesPerSegment must be > 0");
  }
  const segments: Segment[] = [];
  for (let start = 0; start < pageTexts.length; start += pagesPerSegment) {
    const end = Math.min(start + pagesPerSegment, pageTexts.length);
    const chunk = pageTexts.slice(start, end).filter((t) => t.trim().length > 0);
    const merged = chunk.join("\n\n").trim();
    segments.push({
      sourcePdf,
      segmentIndex: segments.length,
      pageStart: start + 1,
      pageEnd: end,
      text: merged,
    });
  }
  return segments;
}

export async function splitPdfIntoSegments(
  sourcePdf: string,
  buffer: Uint8Array,
  pagesPerSegment: number
): Promise<{ segments: Segment[]; pageCount: number }> {
  const pageTexts = await extractPageTexts(buffer);
  const segments = buildSegmentsFromPageTexts(sourcePdf, pageTexts, pagesPerSegment);
  return { segments, pageCount: pageTexts.length };
}

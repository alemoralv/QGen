export type Difficulty = "basic" | "mixed" | "advanced";

export interface GenerationConfig {
  numQuestions: number;
  pagesPerSegment: number;
  difficulty: Difficulty;
  temperature: number;
  maxOutputTokens: number;
  questionInstructions: string;
}

export interface Segment {
  sourcePdf: string;
  segmentIndex: number;
  pageStart: number;
  pageEnd: number;
  text: string;
}

export interface QARecord {
  question: string;
  expectedResponse: string;
  sourcePdf: string;
  segmentIndex: number;
  pageStart: number;
  pageEnd: number;
}

export type StreamEvent =
  | { type: "meta"; totalPdfs: number; pdfs: { name: string; pages: number }[] }
  | { type: "pdf-start"; pdf: string; segments: number; pages: number }
  | {
      type: "segment-progress";
      pdf: string;
      segmentIndex: number;
      produced: number;
      expected: number;
    }
  | { type: "row"; pdf: string; record: QARecord }
  | { type: "pdf-end"; pdf: string; totalRows: number }
  | { type: "done"; totalRows: number }
  | { type: "error"; message: string; pdf?: string };

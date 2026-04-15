import type OpenAI from "openai";
import { gatewayRejectsTemperatureParam } from "./gateway";
import type { GenerationConfig, QARecord, Segment } from "./types";

function buildPrompt(
  segment: Segment,
  questionCount: number,
  instructions: string,
  difficulty: string
): string {
  return `You are generating study questions and expected correct answers from a PDF segment.

Rules:
1) Keep the output language the same as the source text language.
2) Generate exactly ${questionCount} question-answer pairs.
3) Follow these user instructions: ${instructions}
4) Difficulty level: ${difficulty}
5) Ensure answers are concise but complete and factually grounded in the provided text.
6) Output ONLY valid JSON (no markdown), as an array of objects with exactly:
   - question
   - expectedResponse

Source metadata:
- PDF: ${segment.sourcePdf}
- Segment index: ${segment.segmentIndex}
- Page range: ${segment.pageStart}-${segment.pageEnd}

Source text:
"""
${segment.text}
"""`;
}

function extractJsonArray(text: string): Array<Record<string, unknown>> {
  const stripped = text.trim();
  const candidates: string[] = [stripped];

  const fenceMatch = stripped.match(/```(?:json)?\s*(\[[\s\S]*\])\s*```/);
  if (fenceMatch) candidates.unshift(fenceMatch[1]);

  const arrayMatch = stripped.match(/(\[[\s\S]*\])/);
  if (arrayMatch) candidates.push(arrayMatch[1]);

  let lastError: unknown;
  for (const candidate of candidates) {
    const repaired = candidate.replace(/,\s*([\]}])/g, "$1");
    try {
      const parsed = JSON.parse(repaired);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (v): v is Record<string, unknown> =>
            v !== null && typeof v === "object" && !Array.isArray(v)
        );
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not parse JSON array from model output: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function callChat(
  client: OpenAI,
  model: string,
  prompt: string,
  config: GenerationConfig,
  includeTemperature: boolean
) {
  const params: {
    model: string;
    messages: { role: "user"; content: string }[];
    max_tokens: number;
    temperature?: number;
  } = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: config.maxOutputTokens,
  };
  if (includeTemperature) params.temperature = config.temperature;
  return client.chat.completions.create(params);
}

export class QuestionGenerator {
  private omitTemperature = false;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly config: GenerationConfig,
    private readonly retryAttempts = 3,
    private readonly retryBackoffSeconds = 2.0
  ) {}

  private async complete(prompt: string): Promise<string> {
    const include = !this.omitTemperature;
    try {
      const response = await callChat(
        this.client,
        this.model,
        prompt,
        this.config,
        include
      );
      return (response.choices[0]?.message?.content ?? "").trim();
    } catch (err) {
      if (include && gatewayRejectsTemperatureParam(err)) {
        this.omitTemperature = true;
        const response = await callChat(
          this.client,
          this.model,
          prompt,
          this.config,
          false
        );
        return (response.choices[0]?.message?.content ?? "").trim();
      }
      throw err;
    }
  }

  async generate(segment: Segment, questionCount: number): Promise<QARecord[]> {
    if (questionCount <= 0) return [];
    if (!segment.text.trim()) return [];

    const prompt = buildPrompt(
      segment,
      questionCount,
      this.config.questionInstructions,
      this.config.difficulty
    );

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        const text = await this.complete(prompt);
        const rows = extractJsonArray(text);
        const records: QARecord[] = [];
        for (const row of rows.slice(0, questionCount)) {
          const q = String(row.question ?? "").trim();
          const a = String(row.expectedResponse ?? "").trim();
          if (q && a) {
            records.push({
              question: q,
              expectedResponse: a,
              sourcePdf: segment.sourcePdf,
              segmentIndex: segment.segmentIndex,
              pageStart: segment.pageStart,
              pageEnd: segment.pageEnd,
            });
          }
        }
        return records;
      } catch (err) {
        lastErr = err;
        if (attempt < this.retryAttempts) {
          await new Promise((r) =>
            setTimeout(r, this.retryBackoffSeconds * 1000 * attempt)
          );
        }
      }
    }
    throw new Error(
      `Failed to generate Q&A for ${segment.sourcePdf} segment ` +
        `${segment.segmentIndex} after retries: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`
    );
  }
}

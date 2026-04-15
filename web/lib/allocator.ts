import type { Segment } from "./types";

/**
 * Distribute `totalQuestions` across segments that have extractable text.
 * Matches qgen/allocator.py: integer portion + remainder to earliest segments.
 * Returns a map keyed by segment index.
 */
export function allocateQuestionsAcrossSegments(
  segments: Segment[],
  totalQuestions: number
): Map<number, number> {
  if (totalQuestions <= 0) {
    throw new Error("totalQuestions must be > 0");
  }
  const activeIndices = segments
    .map((s, i) => (s.text.trim().length > 0 ? i : -1))
    .filter((i) => i >= 0);

  const allocation = new Map<number, number>();
  if (activeIndices.length === 0) return allocation;

  const base = Math.floor(totalQuestions / activeIndices.length);
  const remainder = totalQuestions % activeIndices.length;
  activeIndices.forEach((idx) => allocation.set(idx, base));
  for (let i = 0; i < remainder; i += 1) {
    const idx = activeIndices[i];
    allocation.set(idx, (allocation.get(idx) ?? 0) + 1);
  }
  return allocation;
}

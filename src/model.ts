import type { ModeEvidence } from "./mode-array";

/**
 * Independent reference model: sort a copy of the slice, then count runs.
 * Because the sort is ascending and a new best is only taken on a strictly
 * longer run, ties resolve to the smaller value — same contract as the
 * library under test. Returns null for an empty slice.
 */
export function sortedCountMode(slice: readonly number[]): ModeEvidence | null {
  if (slice.length === 0) return null;
  const sorted = slice.slice().sort((a, b) => a - b);
  let bestValue = sorted[0]!;
  let bestCount = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1] ? run + 1 : 1;
    if (run > bestCount) {
      bestCount = run;
      bestValue = sorted[i]!;
    }
  }
  return { value: bestValue, count: bestCount };
}

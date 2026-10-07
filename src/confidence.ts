import type { Rational } from "./rational.ts";
import { make, sub, toString as ratToString } from "./rational.ts";
import type { Sample } from "./enumerate.ts";
import { enumerateCompressed, enumerateNaive, validateSamples } from "./enumerate.ts";

export const MAX_DELTAS = 12;

export interface ShiftResult {
  readonly delta: string;
  readonly tailCount: string;
  readonly totalAssignments: string;
  readonly pValue: string;
  readonly included: boolean;
  readonly crossChecked: boolean;
}

export interface ConfidenceSetResult {
  readonly alpha: string;
  readonly included: readonly string[];
  readonly results: readonly ShiftResult[];
}

export function confidenceSet(
  samples: readonly Sample[],
  deltas: readonly Rational[],
  alpha: Rational,
  opts: { verify?: boolean } = {},
): ConfidenceSetResult {
  validateSamples(samples);
  if (deltas.length === 0) throw new Error("at least one candidate delta required");
  if (deltas.length > MAX_DELTAS) {
    throw new Error(`at most ${MAX_DELTAS} candidate shifts supported, got ${deltas.length}`);
  }
  if (alpha.num < 0n) throw new Error("alpha must be non-negative");
  const verify = opts.verify ?? true;
  const results: ShiftResult[] = [];
  const included: string[] = [];
  for (const delta of deltas) {
    const shifted: Sample[] = samples.map((s) => ({ id: s.id, diff: sub(s.diff, delta) }));
    const compressed = enumerateCompressed(shifted);
    let crossChecked = false;
    if (verify) {
      const naive = enumerateNaive(shifted);
      crossChecked =
        naive.tailCount === compressed.tailCount &&
        naive.totalAssignments === compressed.totalAssignments;
      if (!crossChecked) throw new Error("internal cross-check failed: compressed != naive");
    }
    const isIncluded = compressed.tailCount * alpha.den > alpha.num * compressed.totalAssignments;
    const deltaStr = ratToString(delta);
    if (isIncluded) included.push(deltaStr);
    results.push({
      delta: deltaStr,
      tailCount: compressed.tailCount.toString(),
      totalAssignments: compressed.totalAssignments.toString(),
      pValue: ratToString(make(compressed.tailCount, compressed.totalAssignments)),
      included: isIncluded,
      crossChecked: verify ? crossChecked : false,
    });
  }
  return { alpha: ratToString(alpha), included, results };
}

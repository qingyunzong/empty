import {
  type TransitionTable,
  offsetAt,
  ruleIndexAt,
  rules,
} from "./table.js";

export interface UtcToLocalResult {
  readonly utc: number;
  readonly local: number;
  readonly offsetSeconds: number;
  readonly ruleIndex: number;
}

/** Forward map: UTC integer second -> local integer second. Always total. */
export function utcToLocal(table: TransitionTable, utc: number): UtcToLocalResult {
  const ruleIndex = ruleIndexAt(table, utc);
  const offsetSeconds = offsetAt(table, utc);
  return { utc, local: utc + offsetSeconds, offsetSeconds, ruleIndex };
}

export interface UtcCandidate {
  readonly utc: number;
  readonly offsetSeconds: number;
  readonly ruleIndex: number;
}

/**
 * Reverse map result for a local integer second:
 *  - "none":      the local second falls in a gap (offset jumped forward);
 *                 explicitly no solution, candidates is empty.
 *  - "unique":    exactly one UTC second maps to it.
 *  - "ambiguous": the local second falls in an overlap (offset jumped back);
 *                 two candidates for real-world tables, possibly more for
 *                 exotic tables with rapid consecutive transitions.
 */
export interface LocalToUtcResult {
  readonly local: number;
  readonly kind: "none" | "unique" | "ambiguous";
  readonly candidates: readonly UtcCandidate[]; // sorted by utc ascending
}

/**
 * Reverse map: local integer second -> all UTC seconds that forward-map to it.
 * A UTC second u is a candidate for local L under rule r iff
 * u = L - offset_r and u lies in r's half-open UTC domain.
 */
export function localToUtc(table: TransitionTable, local: number): LocalToUtcResult {
  const candidates: UtcCandidate[] = [];
  for (const rule of rules(table)) {
    const utc = local - rule.offsetSeconds;
    if (utc >= rule.utcStart && utc < rule.utcEnd) {
      candidates.push({
        utc,
        offsetSeconds: rule.offsetSeconds,
        ruleIndex: rule.ruleIndex,
      });
    }
  }
  candidates.sort((a, b) => a.utc - b.utc);
  const kind =
    candidates.length === 0 ? "none" : candidates.length === 1 ? "unique" : "ambiguous";
  return { local, kind, candidates };
}

export interface RoundTripVerification {
  readonly utcStart: number;
  readonly utcEnd: number;
  readonly checked: number;
  /** UTC seconds whose reverse lookup did not contain the original UTC. */
  readonly failures: readonly number[];
}

/**
 * Exhaustive per-UTC verification over the half-open domain [utcStart, utcEnd):
 * forward-map every UTC second, then confirm the reverse lookup of the
 * resulting local second contains the original UTC second.
 */
export function verifyRoundTrip(
  table: TransitionTable,
  utcStart: number,
  utcEnd: number,
): RoundTripVerification {
  if (!(utcStart < utcEnd)) {
    throw new RangeError(`empty domain [${utcStart}, ${utcEnd})`);
  }
  const failures: number[] = [];
  for (let utc = utcStart; utc < utcEnd; utc += 1) {
    const { local } = utcToLocal(table, utc);
    const back = localToUtc(table, local);
    if (!back.candidates.some((c) => c.utc === utc)) {
      failures.push(utc);
    }
  }
  return { utcStart, utcEnd, checked: utcEnd - utcStart, failures };
}

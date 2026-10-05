import { findMatching, topoOrder, validateRequirements } from "./matching.js";
import type {
  LogEvent,
  MatchEntry,
  Requirement,
  SearchCertificate,
} from "./types.js";

/**
 * Find the shortest contiguous segment (in the (time, id) ordering) whose
 * events can satisfy every requirement slot via a one-to-one matching.
 * Ties on segment length are broken by the earlier start index.
 *
 * Uses a two-pointer scan: feasibility is monotone in the right endpoint,
 * so for each left endpoint the minimal feasible right endpoint is found
 * by only ever advancing the right pointer.
 */
export function findShortestSegment(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
): SearchCertificate | null {
  validateRequirements(reqs);
  const order = topoOrder(reqs);
  const n = events.length;

  let bestLo = -1;
  let bestHi = -1;
  let bestMatching: Map<number, number> | null = null;
  let hi = -1;

  for (let lo = 0; lo < n; lo++) {
    if (hi < lo - 1) hi = lo - 1;
    let matching: Map<number, number> | null = null;
    while (true) {
      if (hi >= lo) {
        matching = findMatching(events, reqs, lo, hi, order);
        if (matching !== null) break;
      }
      hi++;
      if (hi >= n) break;
    }
    if (matching === null) break; // [lo, n-1] infeasible => any later lo too
    const len = hi - lo + 1;
    if (bestMatching === null || len < bestHi - bestLo + 1) {
      bestLo = lo;
      bestHi = hi;
      bestMatching = matching;
      if (len === 1) break; // global minimum reached at the earliest lo
    }
  }

  if (bestMatching === null) return null;

  const matching: MatchEntry[] = [];
  const entries = [...bestMatching.entries()].sort((a, b) => a[0] - b[0]);
  for (const [r, e] of entries) {
    const ev = events[e]!;
    matching.push({
      requirement: r,
      event: e,
      eventId: ev.id,
      keyword: reqs[r]!.keyword,
      source: ev.source,
    });
  }
  return {
    lo: bestLo,
    hi: bestHi,
    length: bestHi - bestLo + 1,
    requirementCount: reqs.length,
    matching,
  };
}

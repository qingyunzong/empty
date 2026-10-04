import type { LogEvent, Requirement } from "./model.js";
import { findMatching, topoOrder } from "./matching.js";

export interface SegmentMatch {
  start: number;
  end: number;
  match: number[];
}

/**
 * Finds the shortest contiguous segment (fewest events) of the sorted event
 * list that admits a legal matching for all requirements. Ties are broken by
 * the earliest start index.
 *
 * Uses a two-pointer sweep: for a fixed left bound, feasibility is monotone
 * in the right bound, and the minimal feasible right bound never decreases
 * as the left bound advances, so the scan is O(n) matching probes.
 */
export function findShortestSegment(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
): SegmentMatch | null {
  const order = topoOrder(reqs);
  const n = events.length;
  let bestStart = -1;
  let bestEnd = -1;
  let r = -1;
  for (let l = 0; l < n; l++) {
    if (r < l - 1) r = l - 1;
    // Windows cannot shrink below the current best, so cap the scan.
    let cap = n - 1;
    if (bestStart !== -1) cap = Math.min(cap, l + (bestEnd - bestStart + 1) - 2);
    if (r > cap) continue;
    let feasible = findMatching(events, l, r, reqs, order) !== null;
    while (!feasible && r < cap) {
      r++;
      feasible = findMatching(events, l, r, reqs, order) !== null;
    }
    if (!feasible) {
      // Infeasible even at the cap: if no best exists yet, larger left
      // bounds only shrink the window further, so nothing can succeed.
      if (bestStart === -1) break;
      continue;
    }
    if (bestStart === -1 || r - l + 1 < bestEnd - bestStart + 1) {
      bestStart = l;
      bestEnd = r;
    }
  }
  if (bestStart === -1) return null;
  const match = findMatching(events, bestStart, bestEnd, reqs, order)!;
  return { start: bestStart, end: bestEnd, match };
}

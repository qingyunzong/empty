/**
 * Shared route preference ordering:
 *   1. earlier arrival wins;
 *   2. then fewer transfers;
 *   3. then the smaller trip-id sequence in lexicographic order.
 */

export function compareTripSeq(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

export interface Costed {
  arrival: number;
  transfers: number;
  seq: readonly string[];
}

/** Negative when `a` is strictly preferable to `b`. */
export function compareCost(a: Costed, b: Costed): number {
  if (a.arrival !== b.arrival) return a.arrival - b.arrival;
  if (a.transfers !== b.transfers) return a.transfers - b.transfers;
  return compareTripSeq(a.seq, b.seq);
}

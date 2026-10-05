import { Problem } from "./model";

/**
 * Distinguishability structure derived from a problem.
 *
 * Each required (distinguishable) strategy pair owns a bit in the pair
 * universe (a bigint mask). Each sample owns the mask of pairs it can tell
 * apart. Selecting samples so that every pair is distinguished is exactly a
 * minimum hitting-set / set-cover problem over these masks.
 */
export interface DistinguishData {
  /** [strategyA, strategyB] index pairs that differ on at least one sample. */
  requiredPairs: Array<[number, number]>;
  /** Per required pair: bitmask (bit k = sample k) of samples separating it. */
  pairSampleMask: number[];
  /** Per sample: bigint mask over required-pair bits this sample separates. */
  sampleCover: bigint[];
  /** Mask with all required-pair bits set. */
  fullCover: bigint;
  /** Pairs that no candidate sample can separate. */
  equivalentPairs: Array<[number, number]>;
}

export function buildDistinguishData(problem: Problem): DistinguishData {
  const sampleCount = problem.sampleIds.length;
  const strategies = problem.strategies;
  const requiredPairs: Array<[number, number]> = [];
  const pairSampleMask: number[] = [];
  const equivalentPairs: Array<[number, number]> = [];
  const sampleCover: bigint[] = new Array<bigint>(sampleCount).fill(0n);

  for (let a = 0; a < strategies.length; a++) {
    for (let b = a + 1; b < strategies.length; b++) {
      const first = strategies[a]!;
      const second = strategies[b]!;
      let mask = 0;
      for (let s = 0; s < sampleCount; s++) {
        if (first.canonical[s] !== second.canonical[s]) {
          mask |= 1 << s;
        }
      }
      if (mask === 0) {
        equivalentPairs.push([a, b]);
        continue;
      }
      const pairBit = 1n << BigInt(requiredPairs.length);
      requiredPairs.push([a, b]);
      pairSampleMask.push(mask);
      for (let s = 0; s < sampleCount; s++) {
        if (mask & (1 << s)) {
          sampleCover[s] = sampleCover[s]! | pairBit;
        }
      }
    }
  }

  const fullCover = requiredPairs.length === 0 ? 0n : (1n << BigInt(requiredPairs.length)) - 1n;
  return { requiredPairs, pairSampleMask, sampleCover, fullCover, equivalentPairs };
}

function popcount32(value: number): number {
  let v = value;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function bitIndexOfLowest(mask: bigint): number {
  let index = 0;
  let rest = mask;
  while ((rest & 1n) === 0n) {
    rest >>= 1n;
    index++;
  }
  return index;
}

/**
 * Exact minimum number of samples whose coverage union equals `fullCover`.
 * Branch and bound over samples with:
 *  - a packing lower bound (uncovered pairs whose separating-sample sets are
 *    pairwise disjoint each need a distinct sample), and
 *  - most-constrained-pair branching.
 */
export function minimumCoverSize(data: DistinguishData): number {
  const { sampleCover, fullCover, pairSampleMask } = data;
  if (fullCover === 0n) {
    return 0;
  }
  const sampleCount = sampleCover.length;

  // Pair visit order for the packing bound: fewest separating samples first.
  const pairOrder = pairSampleMask
    .map((mask, index) => ({ mask, index }))
    .sort((x, y) => popcount32(x.mask) - popcount32(y.mask))
    .map((entry) => entry.index);

  function packingLowerBound(uncovered: bigint): number {
    let usedSamples = 0;
    let count = 0;
    for (const pairIndex of pairOrder) {
      const bit = 1n << BigInt(pairIndex);
      if ((uncovered & bit) === 0n) continue;
      const mask = pairSampleMask[pairIndex]!;
      if ((mask & usedSamples) === 0) {
        count++;
        usedSamples |= mask;
      }
    }
    return count;
  }

  // Greedy upper bound.
  let best = 0;
  {
    let covered = 0n;
    while (covered !== fullCover) {
      let bestGain = -1n;
      let bestSample = -1;
      for (let s = 0; s < sampleCount; s++) {
        const gain = sampleCover[s]! & ~covered;
        if (gain > bestGain) {
          bestGain = gain;
          bestSample = s;
        }
      }
      covered |= sampleCover[bestSample]!;
      best++;
    }
  }

  const memo = new Map<bigint, number>();

  function search(uncovered: bigint, depth: number): void {
    if (uncovered === 0n) {
      if (depth < best) best = depth;
      return;
    }
    if (depth + packingLowerBound(uncovered) >= best) return;
    const seen = memo.get(uncovered);
    if (seen !== undefined && seen <= depth) return;
    memo.set(uncovered, depth);

    // Most constrained uncovered pair.
    let chosenMask = 0;
    let chosenWidth = Number.MAX_SAFE_INTEGER;
    let rest = uncovered;
    while (rest !== 0n) {
      const bit = rest & -rest;
      const pairIndex = bitIndexOfLowest(bit);
      const width = popcount32(pairSampleMask[pairIndex]!);
      if (width < chosenWidth) {
        chosenWidth = width;
        chosenMask = pairSampleMask[pairIndex]!;
      }
      rest ^= bit;
    }

    // Branch on every sample separating that pair, best coverage first.
    const options: number[] = [];
    for (let s = 0; s < sampleCount; s++) {
      if (chosenMask & (1 << s)) options.push(s);
    }
    options.sort((x, y) => {
      const gx = sampleCover[x]! & uncovered;
      const gy = sampleCover[y]! & uncovered;
      return gx === gy ? x - y : gx > gy ? -1 : 1;
    });
    for (const s of options) {
      search(uncovered & ~sampleCover[s]!, depth + 1);
    }
  }

  search(fullCover, 0);
  return best;
}

/**
 * Lexicographically smallest feasible subset of exactly `size` samples, where
 * samples are enumerated in `order` (e.g. sorted by sample id). Returns the
 * chosen sample indexes, or null if none exists. Uses suffix-OR pruning only.
 */
export function firstFeasibleOfSize(
  sampleCover: bigint[],
  fullCover: bigint,
  size: number,
  order: number[]
): number[] | null {
  if (size === 0) {
    return fullCover === 0n ? [] : null;
  }
  const suffixOr = new Array<bigint>(order.length + 1).fill(0n);
  for (let i = order.length - 1; i >= 0; i--) {
    suffixOr[i] = suffixOr[i + 1]! | sampleCover[order[i]!]!;
  }
  const chosen: number[] = [];

  function dfs(position: number, acc: bigint): number[] | null {
    if (chosen.length === size) {
      return acc === fullCover ? chosen.slice() : null;
    }
    const remainingSlots = size - chosen.length;
    if (order.length - position < remainingSlots) return null;
    if ((acc | suffixOr[position]!) !== fullCover) return null;
    for (let i = position; i <= order.length - remainingSlots; i++) {
      chosen.push(order[i]!);
      const found = dfs(i + 1, acc | sampleCover[order[i]!]!);
      if (found) return found;
      chosen.pop();
    }
    return null;
  }

  return dfs(0, 0n);
}

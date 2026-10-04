import { canonical, ProblemSpec } from "./model.js";

export interface PairInfo {
  /** The two strategy ids, in input order. */
  strategies: [string, string];
  /** Ids of the candidate samples on which the two strategies differ. */
  distinguishingSampleIds: string[];
  /** True when no candidate sample can tell the two strategies apart. */
  equivalent: boolean;
}

/**
 * A group of samples with an identical distinguishing signature. Any member of
 * the group is interchangeable in an optimal selection; the representative is
 * the lexicographically smallest sample id of the group.
 */
export interface Column {
  representativeId: string;
  memberIds: string[];
  /** Bit p is set when this column distinguishes pair p. */
  pairMask: bigint;
}

export interface Analysis {
  sampleIds: string[];
  strategyIds: string[];
  pairs: PairInfo[];
  equivalentPairs: PairInfo[];
  distinguishablePairCount: number;
  /** Samples that distinguish no pair at all and can never be useful. */
  uselessSampleIds: string[];
  columns: Column[];
  /** Bit p is set when pair p is distinguishable by at least one sample. */
  fullMask: bigint;
}

function popcount(mask: bigint): number {
  let count = 0;
  let rest = mask;
  while (rest !== 0n) {
    rest &= rest - 1n;
    count += 1;
  }
  return count;
}

function* setBits(mask: bigint): Generator<number> {
  let rest = mask;
  while (rest !== 0n) {
    const lowest = rest & -rest;
    let bit = 0;
    let value = lowest;
    while (value > 1n) {
      value >>= 1n;
      bit += 1;
    }
    yield bit;
    rest ^= lowest;
  }
}

/** Compare every strategy pair on every sample and deduplicate samples. */
export function analyze(problem: ProblemSpec): Analysis {
  const sampleIds = problem.samples.map((s) => s.id);
  const strategyIds = problem.strategies.map((s) => s.id);
  const strategyCount = problem.strategies.length;
  const sampleCount = problem.samples.length;
  const outputs = problem.strategies.map((s) => s.outputs.map(canonical));

  const pairList: Array<[number, number]> = [];
  for (let i = 0; i < strategyCount; i += 1) {
    for (let j = i + 1; j < strategyCount; j += 1) {
      pairList.push([i, j]);
    }
  }

  // sampleMasks[p]: bit k set when sample k distinguishes pair p.
  const sampleMasks: number[] = new Array<number>(pairList.length).fill(0);
  // pairMasks[k]: bit p set when sample k distinguishes pair p.
  const pairMasks: bigint[] = new Array<bigint>(sampleCount).fill(0n);
  for (let p = 0; p < pairList.length; p += 1) {
    const [i, j] = pairList[p]!;
    for (let k = 0; k < sampleCount; k += 1) {
      if (outputs[i]![k] !== outputs[j]![k]) {
        sampleMasks[p]! |= 1 << k;
        pairMasks[k]! |= 1n << BigInt(p);
      }
    }
  }

  const pairs: PairInfo[] = pairList.map(([i, j], p) => {
    const distinguishingSampleIds: string[] = [];
    for (let k = 0; k < sampleCount; k += 1) {
      if ((sampleMasks[p]! & (1 << k)) !== 0) {
        distinguishingSampleIds.push(sampleIds[k]!);
      }
    }
    return {
      strategies: [strategyIds[i]!, strategyIds[j]!],
      distinguishingSampleIds,
      equivalent: distinguishingSampleIds.length === 0,
    };
  });

  let fullMask = 0n;
  const groups = new Map<bigint, string[]>();
  const uselessSampleIds: string[] = [];
  for (let k = 0; k < sampleCount; k += 1) {
    const mask = pairMasks[k]!;
    fullMask |= mask;
    if (mask === 0n) {
      uselessSampleIds.push(sampleIds[k]!);
      continue;
    }
    const group = groups.get(mask);
    if (group) {
      group.push(sampleIds[k]!);
    } else {
      groups.set(mask, [sampleIds[k]!]);
    }
  }

  const columns: Column[] = [...groups.entries()]
    .map(([pairMask, memberIds]) => {
      const sorted = [...memberIds].sort();
      return { representativeId: sorted[0]!, memberIds: sorted, pairMask };
    })
    .sort((a, b) => (a.representativeId < b.representativeId ? -1 : 1));

  return {
    sampleIds,
    strategyIds,
    pairs,
    equivalentPairs: pairs.filter((p) => p.equivalent),
    distinguishablePairCount: pairs.length - pairs.filter((p) => p.equivalent).length,
    uselessSampleIds,
    columns,
    fullMask,
  };
}

/**
 * Exact minimum number of columns needed to cover every distinguishable pair.
 * Iterative-deepening DFS: at each node, branch on the columns that
 * distinguish the uncovered pair with the fewest remaining options (MRV),
 * with a transposition table keyed on the covered-pair mask.
 */
export function findMinimumSize(columns: Column[], fullMask: bigint): number {
  if (fullMask === 0n) {
    return 0;
  }
  const columnMasks = columns.map((c) => c.pairMask);

  // pairColumns[p]: bit c set when column c distinguishes pair p.
  let pairCount = 0;
  for (const bit of setBits(fullMask)) {
    pairCount = bit + 1;
  }
  const pairColumns: bigint[] = new Array<bigint>(pairCount).fill(0n);
  for (let c = 0; c < columnMasks.length; c += 1) {
    for (const p of setBits(columnMasks[c]!)) {
      pairColumns[p]! |= 1n << BigInt(c);
    }
  }

  function search(covered: bigint, usedColumns: bigint, remaining: number, seen: Map<bigint, number>): boolean {
    if (covered === fullMask) {
      return true;
    }
    if (remaining === 0) {
      return false;
    }
    const previous = seen.get(covered);
    if (previous !== undefined && previous >= remaining) {
      return false;
    }
    seen.set(covered, remaining);

    // Most-constrained uncovered pair first.
    let bestPair = -1;
    let bestBranches = 0n;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const p of setBits(fullMask & ~covered & fullMask)) {
      const branches = pairColumns[p]! & ~usedColumns;
      const count = popcount(branches);
      if (count === 0) {
        return false; // Pair cannot be covered with the columns left.
      }
      if (count < bestCount) {
        bestCount = count;
        bestPair = p;
        bestBranches = branches;
        if (count === 1) {
          break;
        }
      }
    }
    if (bestPair < 0) {
      return false;
    }

    for (const c of setBits(bestBranches)) {
      if (
        search(
          covered | columnMasks[c]!,
          usedColumns | (1n << BigInt(c)),
          remaining - 1,
          seen
        )
      ) {
        return true;
      }
    }
    return false;
  }

  for (let depth = 1; depth <= columns.length; depth += 1) {
    const seen = new Map<bigint, number>();
    if (search(0n, 0n, depth, seen)) {
      return depth;
    }
  }
  return columns.length;
}

/**
 * Among all minimum-size column selections, return the one whose sorted
 * representative ids are lexicographically smallest. Columns are already
 * sorted by representative id, so plain lexicographic combination order works.
 */
export function selectRepresentatives(
  columns: Column[],
  size: number,
  fullMask: bigint
): string[] {
  if (size === 0) {
    return [];
  }
  const chosen: number[] = [];

  function search(start: number, mask: bigint): number[] | null {
    if (chosen.length === size) {
      return mask === fullMask ? [...chosen] : null;
    }
    for (let i = start; i < columns.length; i += 1) {
      chosen.push(i);
      const hit = search(i + 1, mask | columns[i]!.pairMask);
      if (hit !== null) {
        return hit;
      }
      chosen.pop();
    }
    return null;
  }

  const selected = search(0, 0n);
  if (selected === null) {
    throw new Error("no covering selection of the requested size exists");
  }
  return selected.map((i) => columns[i]!.representativeId).sort();
}


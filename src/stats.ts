export type Ranker = (values: readonly number[]) => number[];

export function exactMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index }));
  order.sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) {
      end += 1;
    }
    const rank = (start + 1 + end + 1) / 2;
    for (let k = start; k <= end; k += 1) {
      ranks[order[k].index] = rank;
    }
    start = end + 1;
  }
  return ranks;
}

export function averageRanksByCounting(values: readonly number[]): number[] {
  return values.map((value) => {
    let smaller = 0;
    let equal = 0;
    for (const other of values) {
      if (other < value) smaller += 1;
      else if (other === value) equal += 1;
    }
    return 1 + smaller + (equal - 1) / 2;
  });
}

export interface SignedRankOutcome {
  n: number;
  droppedZeros: number;
  ranks: number[];
  tPlus: number;
  tMinus: number;
  statistic: number;
  permutations: number;
  extremeCount: number;
  pValue: number;
}

export const MAX_EXACT_SIGN_COUNT = 25;

export function wilcoxonSignedRankExact(
  diffs: readonly number[],
  ranker: Ranker = averageRanks,
  maxSignCount: number = MAX_EXACT_SIGN_COUNT,
): SignedRankOutcome | null {
  const kept: number[] = [];
  let droppedZeros = 0;
  for (const diff of diffs) {
    if (diff === 0) droppedZeros += 1;
    else kept.push(diff);
  }
  if (kept.length === 0) return null;
  if (kept.length > maxSignCount) {
    throw new Error(
      `exact sign-reassignment test requires 2^${kept.length} enumerations; limit is ${maxSignCount}`,
    );
  }
  const ranks = ranker(kept.map((d) => Math.abs(d)));
  let tPlus = 0;
  let tMinus = 0;
  for (let i = 0; i < kept.length; i += 1) {
    if (kept[i] > 0) tPlus += ranks[i];
    else tMinus += ranks[i];
  }
  const statistic = Math.abs(tPlus - tMinus);
  const totalRank = tPlus + tMinus;
  const permutations = 2 ** kept.length;
  let extremeCount = 0;
  for (let mask = 0; mask < permutations; mask += 1) {
    let sum = 0;
    for (let bit = 0; bit < kept.length; bit += 1) {
      if ((mask & (1 << bit)) !== 0) sum += ranks[bit];
    }
    const reassigned = Math.abs(2 * sum - totalRank);
    if (reassigned + 1e-9 >= statistic) extremeCount += 1;
  }
  return {
    n: kept.length,
    droppedZeros,
    ranks,
    tPlus,
    tMinus,
    statistic,
    permutations,
    extremeCount,
    pValue: extremeCount / permutations,
  };
}

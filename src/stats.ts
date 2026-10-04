export function exactMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function averageRanks(absValues: readonly number[]): number[] {
  const order = absValues
    .map((value, index) => ({ value, index }))
    .sort((x, y) => x.value - y.value);
  const ranks = new Array<number>(absValues.length).fill(0);
  let lo = 0;
  while (lo < order.length) {
    let hi = lo;
    while (hi + 1 < order.length && order[hi + 1].value === order[lo].value) hi++;
    const avgRank = (lo + 1 + (hi + 1)) / 2;
    for (let k = lo; k <= hi; k++) ranks[order[k].index] = avgRank;
    lo = hi + 1;
  }
  return ranks;
}

export interface SignedRankCore {
  readonly n: number;
  readonly keptDiffs: ReadonlyArray<{ readonly index: number; readonly diff: number }>;
  readonly absRanks: ReadonlyArray<number>;
  readonly wPlus: number;
  readonly wMinus: number;
  readonly statistic: number;
  readonly extremeCount: bigint;
  readonly totalReassignments: bigint;
  readonly pValue: number;
}

export function wilcoxonSignedRankExact(diffs: readonly number[]): SignedRankCore | null {
  const kept: Array<{ index: number; diff: number }> = [];
  diffs.forEach((diff, index) => {
    if (diff !== 0) kept.push({ index, diff });
  });
  const n = kept.length;
  if (n === 0) return null;

  const absRanks = averageRanks(kept.map((k) => Math.abs(k.diff)));
  const scaled = absRanks.map((r) => Math.round(r * 2));
  const totalScaled = scaled.reduce((acc, s) => acc + s, 0);

  let wPlusScaled = 0;
  for (let i = 0; i < n; i++) {
    if (kept[i].diff > 0) wPlusScaled += scaled[i];
  }
  const wMinusScaled = totalScaled - wPlusScaled;

  const tObs = Math.abs(2 * wPlusScaled - totalScaled);

  const dp = new Array<bigint>(totalScaled + 1).fill(0n);
  dp[0] = 1n;
  for (const s of scaled) {
    for (let w = totalScaled; w >= s; w--) dp[w] += dp[w - s];
  }

  const totalReassignments = 1n << BigInt(n);
  let extremeCount: bigint;
  if (tObs === 0) {
    extremeCount = totalReassignments;
  } else {
    const hi = (totalScaled + tObs) / 2;
    const lo = (totalScaled - tObs) / 2;
    let count = 0n;
    for (let w = hi; w <= totalScaled; w++) count += dp[w];
    for (let w = 0; w <= lo; w++) count += dp[w];
    extremeCount = count;
  }

  const pValue = Number(extremeCount) / Number(totalReassignments);
  return {
    n,
    keptDiffs: kept,
    absRanks,
    wPlus: wPlusScaled / 2,
    wMinus: wMinusScaled / 2,
    statistic: tObs / 2,
    extremeCount,
    totalReassignments,
    pValue,
  };
}

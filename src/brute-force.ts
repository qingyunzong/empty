/**
 * Reference implementation: enumerate every subset of indices to find the
 * longest strictly increasing subsequence and the lexicographically smallest
 * INDEX sequence among all optima. Used to cross-check the main algorithm on
 * small sequences (length and unique selection).
 */

export interface BruteForceResult {
  /** Maximum achievable length. */
  readonly length: number;
  /** Lexicographically smallest index sequence among all optimal subsets. */
  readonly indices: readonly number[];
  /** Number of subsets achieving the maximum length (selection is the unique lex-min of these). */
  readonly optimalCount: number;
}

function indexLexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

export function bruteForceLis(values: readonly number[]): BruteForceResult {
  const n = values.length;
  if (n > 26) throw new RangeError("brute force limited to n <= 26");
  let bestLen = 0;
  let bestIdx: number[] = [];
  let optimalCount = 0;
  const total = 2 ** n;
  for (let mask = 0; mask < total; mask++) {
    const idx: number[] = [];
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      if ((mask & (1 << i)) !== 0) {
        if (idx.length > 0 && values[i] <= values[idx[idx.length - 1]]) {
          ok = false;
        } else {
          idx.push(i);
        }
      }
    }
    if (!ok) continue;
    if (idx.length > bestLen) {
      bestLen = idx.length;
      bestIdx = idx;
      optimalCount = 1;
    } else if (idx.length === bestLen) {
      optimalCount++;
      if (indexLexLess(idx, bestIdx)) bestIdx = idx;
    }
  }
  return { length: bestLen, indices: bestIdx, optimalCount };
}

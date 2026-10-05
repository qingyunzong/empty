/**
 * Sequence library supporting append-at-end and undo, returning the longest
 * strictly increasing subsequence (LIS).
 *
 * Tie-breaking rule: among all longest strictly increasing subsequences, the
 * one whose INDEX sequence is lexicographically smallest is returned.
 * Value order is never used as a substitute for index order.
 *
 * The result is returned as an index certificate that can be verified
 * independently against the sequence.
 */

export interface LisCertificate {
  /** Length of the longest strictly increasing subsequence. */
  readonly length: number;
  /**
   * Indices into the sequence (0-based, strictly increasing).
   * Lexicographically smallest index sequence among all LIS of max length.
   */
  readonly indices: readonly number[];
  /** Values at `indices`; strictly increasing. */
  readonly values: readonly number[];
}

/** Coordinate-compress values to ranks 1..m (order-preserving). */
function compress(values: readonly number[]): { ranks: number[]; m: number } {
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  const rankOf = new Map<number, number>();
  for (let i = 0; i < uniq.length; i++) rankOf.set(uniq[i], i + 1);
  return { ranks: values.map((v) => rankOf.get(v)!), m: uniq.length };
}

/**
 * Independent O(n log n) length oracle (patience sorting). Used to certify
 * the `length` field of a certificate without trusting the main algorithm.
 */
export function lisLength(values: readonly number[]): number {
  const tails: number[] = [];
  for (const v of values) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
  }
  return tails.length;
}

/**
 * Compute the LIS certificate with index-lexicographic tie-breaking.
 *
 * Algorithm:
 *  1. lisFrom[i] = length of the longest strictly increasing subsequence
 *     that starts at index i (computed right-to-left with a Fenwick tree
 *     over compressed values, querying ranks strictly greater than a[i]).
 *  2. Greedy reconstruction: for the k-th element, pick the SMALLEST index
 *     i greater than the previous pick with a[i] > previous value and
 *     lisFrom[i] === remaining length. Such an i always exists, and choosing
 *     the smallest feasible index at every position yields the
 *     lexicographically smallest index sequence (exchange argument: any LIS
 *     with a smaller index at the first differing position would have been
 *     feasible and chosen instead).
 *
 * Note: the classical "smallest tail values" reconstruction minimizes the
 * VALUE sequence, not the index sequence, and is deliberately not used.
 */
export function computeLisCertificate(values: readonly number[]): LisCertificate {
  const n = values.length;
  if (n === 0) return { length: 0, indices: [], values: [] };

  const { ranks, m } = compress(values);
  const bit = new Array<number>(m + 2).fill(0);
  const bitUpdate = (pos: number, val: number): void => {
    for (let i = pos; i <= m; i += i & -i) if (val > bit[i]) bit[i] = val;
  };
  const bitQuery = (pos: number): number => {
    let best = 0;
    for (let i = pos; i > 0; i -= i & -i) if (bit[i] > best) best = bit[i];
    return best;
  };

  // Fenwick tree keyed by reversed rank so "values > a[i]" becomes a prefix max.
  const lisFrom = new Array<number>(n);
  let total = 0;
  for (let i = n - 1; i >= 0; i--) {
    const rev = m - ranks[i] + 1;
    lisFrom[i] = bitQuery(rev - 1) + 1;
    bitUpdate(rev, lisFrom[i]);
    if (lisFrom[i] > total) total = lisFrom[i];
  }

  const indices: number[] = [];
  let remaining = total;
  let prevValue = -Infinity;
  let start = 0;
  while (remaining > 0) {
    for (let i = start; i < n; i++) {
      if (values[i] > prevValue && lisFrom[i] === remaining) {
        indices.push(i);
        prevValue = values[i];
        start = i + 1;
        remaining--;
        break;
      }
    }
  }

  return {
    length: total,
    indices,
    values: indices.map((i) => values[i]),
  };
}

/**
 * Verify an index certificate against a sequence:
 *  - indices are in range and strictly increasing;
 *  - cert.values match the sequence at those indices and strictly increase;
 *  - cert.length is consistent and equals the true LIS length (checked with
 *    the independent patience-sorting oracle).
 */
export function verifyCertificate(
  values: readonly number[],
  cert: LisCertificate,
): boolean {
  const { length, indices, values: certValues } = cert;
  if (!Number.isInteger(length) || length < 0) return false;
  if (indices.length !== length || certValues.length !== length) return false;
  for (let k = 0; k < length; k++) {
    const idx = indices[k];
    if (!Number.isInteger(idx) || idx < 0 || idx >= values.length) return false;
    if (k > 0 && idx <= indices[k - 1]) return false;
    if (certValues[k] !== values[idx]) return false;
    if (k > 0 && certValues[k] <= certValues[k - 1]) return false;
  }
  return length === lisLength(values);
}

/**
 * A mutable sequence supporting append-at-end and undo, with LIS queries.
 */
export class SequenceLibrary {
  private readonly data: number[] = [];

  /** Append a value at the end. */
  append(value: number): void {
    this.data.push(value);
  }

  /** Remove and return the last appended value. Throws if empty. */
  undo(): number {
    const v = this.data.pop();
    if (v === undefined) throw new RangeError("undo on empty sequence");
    return v;
  }

  get size(): number {
    return this.data.length;
  }

  /** Current sequence contents (defensive copy). */
  snapshot(): number[] {
    return [...this.data];
  }

  /** LIS certificate for the current sequence. */
  lisCertificate(): LisCertificate {
    return computeLisCertificate(this.data);
  }

  /** Verify a certificate (defaults to the current one). */
  verify(cert: LisCertificate = this.lisCertificate()): boolean {
    return verifyCertificate(this.data, cert);
  }
}

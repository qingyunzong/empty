import { Rat, rat, ZERO, add, sub, abs, cmp, isZero, key, toString, parse } from "./rational.js";

export interface Sample { readonly id: string; readonly diff: Rat; }

export const MAX_SAMPLES = 20;
export const MAX_CANDIDATES = 12;

export function makeSamples(entries: ReadonlyArray<{ id: string; diff: string }>): Sample[] {
  if (entries.length > MAX_SAMPLES) {
    throw new Error(`too many samples: ${entries.length} > ${MAX_SAMPLES}`);
  }
  const seen = new Set<string>();
  return entries.map((e) => {
    if (seen.has(e.id)) throw new Error(`duplicate sample id: ${e.id}`);
    seen.add(e.id);
    return { id: e.id, diff: parse(e.diff) };
  });
}

/** Removes samples by id; unknown ids are an error so withdrawals are never silently dropped. */
export function withdraw(samples: readonly Sample[], ids: readonly string[]): Sample[] {
  const drop = new Set(ids);
  const have = new Set(samples.map((s) => s.id));
  for (const id of ids) if (!have.has(id)) throw new Error(`withdraw: unknown sample id ${id}`);
  return samples.filter((s) => !drop.has(s.id));
}

/** Shifts every paired difference by -delta (exact rational arithmetic). */
export function shiftSamples(samples: readonly Sample[], delta: Rat): Sample[] {
  return samples.map((s) => ({ id: s.id, diff: sub(s.diff, delta) }));
}

export interface TailCount {
  /** assignments whose |sum of signed diffs| >= |observed sum| */
  readonly countGE: bigint;
  /** total sign assignments; zero diffs carry a single sign so total = 2^(nonzero count) */
  readonly total: bigint;
  readonly observedSum: Rat;
  /** observed statistic: |mean of diffs| = |observedSum| / n */
  readonly observedStat: Rat;
  readonly nonzeroCount: number;
  readonly zeroCount: number;
}

interface Prepared {
  readonly n: number;
  readonly zeroCount: number;
  /** nonzero sample ids, in input order (sample identity is preserved) */
  readonly ids: readonly string[];
  /** diffs scaled to a common denominator: diff_i = X_i / L */
  readonly L: bigint;
  readonly X: readonly bigint[];
  readonly observedSumInt: bigint; // sum of X_i
}

function lcm(a: bigint, b: bigint): bigint {
  const g = ((): bigint => {
    let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
    while (y !== 0n) { const t = x % y; x = y; y = t; }
    return x === 0n ? 1n : x;
  })();
  return (a / g) * b;
}

function prepare(samples: readonly Sample[]): Prepared {
  const nonzero = samples.filter((s) => !isZero(s.diff));
  let L = 1n;
  for (const s of nonzero) L = lcm(L, s.diff.d);
  const X = nonzero.map((s) => s.diff.n * (L / s.diff.d));
  const observedSumInt = X.reduce((a, b) => a + b, 0n);
  return {
    n: samples.length,
    zeroCount: samples.length - nonzero.length,
    ids: nonzero.map((s) => s.id),
    L,
    X,
    observedSumInt,
  };
}

function buildTail(p: Prepared, countGE: bigint, total: bigint): TailCount {
  const observedSum = rat(p.observedSumInt, p.L);
  const observedStat = p.n === 0 ? ZERO : rat(
    p.observedSumInt < 0n ? -p.observedSumInt : p.observedSumInt,
    p.L * BigInt(p.n),
  );
  return {
    countGE, total, observedSum, observedStat,
    nonzeroCount: p.ids.length, zeroCount: p.zeroCount,
  };
}

/**
 * Naive engine: enumerates every sign assignment mask over the nonzero samples,
 * one bit per sample id. Zero diffs are excluded (single sign). Chunked so a
 * checkpoint callback can persist progress after each chunk.
 */
export function enumerateNaive(
  samples: readonly Sample[],
  opts: {
    startMask?: bigint;
    initialCountGE?: bigint;
    chunkSize?: number;
    /** called after each chunk with (nextMask, countGEsoFar); return false to stop early */
    onChunk?: (nextMask: bigint, countGE: bigint) => boolean | void;
  } = {},
): { tail: TailCount; complete: boolean; nextMask: bigint } {
  const p = prepare(samples);
  const m = p.ids.length;
  const total = 1n << BigInt(m);
  const threshold = p.observedSumInt < 0n ? -p.observedSumInt : p.observedSumInt;
  const chunk = BigInt(opts.chunkSize ?? 1 << 16);
  let countGE = opts.initialCountGE ?? 0n;
  let mask = opts.startMask ?? 0n;
  let complete = true;
  while (mask < total) {
    const end = mask + chunk < total ? mask + chunk : total;
    for (; mask < end; mask++) {
      let sum = 0n;
      for (let i = 0; i < m; i++) {
        sum += (mask >> BigInt(i)) & 1n ? p.X[i] : -p.X[i];
      }
      if (sum < 0n) sum = -sum;
      if (sum >= threshold) countGE++;
    }
    if (opts.onChunk && opts.onChunk(mask, countGE) === false) { complete = false; break; }
  }
  return { tail: buildTail(p, countGE, total), complete, nextMask: mask };
}

/**
 * Compressed engine: groups identical nonzero diffs (exact rational equality)
 * and enumerates, per group, how many of its m_j copies take the + sign.
 * Multiplicity is preserved exactly through binomial weights C(m_j, k_j).
 */
export function enumerateCompressed(samples: readonly Sample[]): TailCount {
  const p = prepare(samples);
  const groups = new Map<string, { v: bigint; mult: number }>();
  for (let i = 0; i < p.ids.length; i++) {
    const k = p.X[i].toString();
    const g = groups.get(k);
    if (g) g.mult++; else groups.set(k, { v: p.X[i], mult: 1 });
  }
  const gs = [...groups.values()];
  // binomial coefficients per group
  const binoms = gs.map((g) => {
    const row: bigint[] = [1n];
    for (let k = 1; k <= g.mult; k++) {
      row.push((row[k - 1] * BigInt(g.mult - k + 1)) / BigInt(k));
    }
    return row;
  });
  const threshold = p.observedSumInt < 0n ? -p.observedSumInt : p.observedSumInt;
  const total = 1n << BigInt(p.ids.length);
  let countGE = 0n;
  const k = new Array<number>(gs.length).fill(0);
  // odometer enumeration over k_j in [0, m_j]
  for (;;) {
    let sum = 0n, weight = 1n;
    for (let j = 0; j < gs.length; j++) {
      sum += BigInt(2 * k[j] - gs[j].mult) * gs[j].v;
      weight *= binoms[j][k[j]];
    }
    const a = sum < 0n ? -sum : sum;
    if (a >= threshold) countGE += weight;
    let j = 0;
    while (j < gs.length) {
      k[j]++;
      if (k[j] <= gs[j].mult) break;
      k[j] = 0; j++;
    }
    if (j === gs.length) break;
  }
  return buildTail(p, countGE, total);
}

/** Exact two-sided p-value as a rational: countGE / total. */
export function pValue(tail: TailCount): Rat {
  return rat(tail.countGE, tail.total);
}

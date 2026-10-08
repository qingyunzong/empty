/**
 * Core math for inverting chained rational discounts with round-half-even.
 *
 * Forward step:   x  ->  roundHalfEven(p * x / q)        (p, q positive integers)
 * Inversion:      given final rounded amount y, find every integer original
 *                 price x0 in [0, CAP] whose chained forward evaluation is y.
 *
 * Each forward step is monotone non-decreasing in x, so the preimage of an
 * interval under one step is again a single interval; a chain therefore maps
 * the target point back to one closed interval (possibly empty). All
 * arithmetic uses BigInt so prices up to 10^12 (and beyond) stay exact.
 */

export interface Step {
  /** numerator of the rational multiplier */
  readonly p: bigint;
  /** denominator of the rational multiplier */
  readonly q: bigint;
}

export interface Interval {
  readonly lo: bigint;
  readonly hi: bigint;
}

/** Inclusive upper bound for the original price: 10^12. */
export const DEFAULT_CAP: bigint = 1_000_000_000_000n;

export const MAX_STEPS = 8;

/** Round n / q to the nearest integer, ties to even. Requires n >= 0, q > 0. */
export function roundHalfEvenDiv(n: bigint, q: bigint): bigint {
  if (n < 0n || q <= 0n) throw new RangeError("roundHalfEvenDiv: need n >= 0, q > 0");
  const k = n / q;
  const r = n % q;
  const twice = 2n * r;
  if (twice < q) return k;
  if (twice > q) return k + 1n;
  return k % 2n === 0n ? k : k + 1n;
}

/** Evaluate the whole discount chain forward from an original price. */
export function forward(x: bigint, steps: readonly Step[]): bigint {
  if (x < 0n) throw new RangeError("forward: price must be >= 0");
  let v = x;
  for (const { p, q } of steps) {
    v = roundHalfEvenDiv(p * v, q);
  }
  return v;
}

/**
 * Smallest x >= 0 with roundHalfEven(p*x/q) >= a, for a >= 0.
 *
 * round(v) >= a  iff  v > a - 1/2, or (v == a - 1/2 and a is even)
 * (a tie at a - 1/2 rounds to the even neighbour of {a-1, a}).
 * In integers with v = p*x/q:  2*p*x  vs  q*(2a - 1).
 */
function preimageLo(a: bigint, p: bigint, q: bigint): bigint {
  if (a <= 0n) return 0n;
  const d = 2n * p;
  const t = q * (2n * a - 1n); // > 0 because a >= 1
  const quot = t / d;
  const rem = t % d;
  if (rem === 0n && a % 2n === 0n) return quot; // tie lands on a (even)
  return quot + 1n;
}

/**
 * Largest x >= 0 with roundHalfEven(p*x/q) <= b, for b >= 0.
 *
 * round(v) <= b  iff  v < b + 1/2, or (v == b + 1/2 and b is even).
 * In integers:  2*p*x  vs  q*(2b + 1).
 */
function preimageHi(b: bigint, p: bigint, q: bigint): bigint {
  const d = 2n * p;
  const u = q * (2n * b + 1n);
  const quot = u / d;
  const rem = u % d;
  if (rem === 0n) {
    // exact tie at b + 1/2: included only when b is even
    return b % 2n === 0n ? quot : quot - 1n;
  }
  return quot; // floor(u/d) == ceil(u/d) - 1 when not divisible
}

/**
 * Preimage of an interval set under one step  x -> roundHalfEven(p*x/q).
 * Monotonicity keeps images disjoint and ordered, so no merge is needed here.
 */
export function invertStep(intervals: readonly Interval[], step: Step): Interval[] {
  const out: Interval[] = [];
  for (const { lo, hi } of intervals) {
    const nlo = preimageLo(lo, step.p, step.q);
    const nhi = preimageHi(hi, step.p, step.q);
    if (nlo <= nhi) out.push({ lo: nlo, hi: nhi });
  }
  return out;
}

/** Clamp intervals to [0, cap], drop empties, merge overlapping/adjacent. */
export function normalize(intervals: readonly Interval[], cap: bigint): Interval[] {
  const clipped: Interval[] = [];
  for (const { lo, hi } of intervals) {
    const nlo = lo < 0n ? 0n : lo;
    const nhi = hi > cap ? cap : hi;
    if (nlo <= nhi) clipped.push({ lo: nlo, hi: nhi });
  }
  clipped.sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const merged: Interval[] = [];
  for (const iv of clipped) {
    const last = merged[merged.length - 1];
    // integer intervals: adjacent (lo == prev.hi + 1) unions into one closed interval
    if (last && iv.lo <= last.hi + 1n) {
      if (iv.hi > last.hi) merged[merged.length - 1] = { lo: last.lo, hi: iv.hi };
    } else {
      merged.push(iv);
    }
  }
  return merged;
}

/**
 * Invert a full chain: every integer original price in [0, cap] whose
 * forward evaluation equals `amount`, as disjoint closed intervals.
 */
export function invertChain(
  amount: bigint,
  steps: readonly Step[],
  cap: bigint = DEFAULT_CAP,
): Interval[] {
  if (steps.length < 1 || steps.length > MAX_STEPS) {
    throw new RangeError(`chain length must be 1..${MAX_STEPS}, got ${steps.length}`);
  }
  if (amount < 0n) throw new RangeError("amount must be >= 0");
  let intervals: Interval[] = [{ lo: amount, hi: amount }];
  for (let i = steps.length - 1; i >= 0; i--) {
    intervals = invertStep(intervals, steps[i]!);
    if (intervals.length === 0) return [];
  }
  return normalize(intervals, cap);
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly exhaustive: boolean;
  readonly checked: bigint;
  readonly failures: string[];
}

/**
 * Forward-computation check of an inversion result.
 *
 * Low price domain (hi <= exhaustiveBelow): every single value inside each
 * interval is forward-evaluated, plus the two values just outside.
 * Above that: boundary values and a midpoint sample per interval.
 */
export function verifyIntervals(
  amount: bigint,
  steps: readonly Step[],
  intervals: readonly Interval[],
  cap: bigint = DEFAULT_CAP,
  exhaustiveBelow: bigint = 1_000_000n,
): VerifyReport {
  const failures: string[] = [];
  let checked = 0n;
  let exhaustive = true;

  const expect = (x: bigint, wantHit: boolean): void => {
    checked++;
    const got = forward(x, steps) === amount;
    if (got !== wantHit) {
      failures.push(
        `x=${x}: forward ${wantHit ? "missed" : "unexpectedly hit"} amount ${amount}`,
      );
    }
  };

  for (const { lo, hi } of intervals) {
    if (hi <= exhaustiveBelow) {
      for (let x = lo; x <= hi; x++) expect(x, true);
    } else {
      exhaustive = false;
      const mid = (lo + hi) / 2n;
      for (const x of [lo, lo + 1n, mid, hi - 1n, hi]) expect(x, true);
    }
    if (lo > 0n) expect(lo - 1n, false);
    if (hi < cap) expect(hi + 1n, false);
  }
  return { ok: failures.length === 0, exhaustive, checked, failures };
}

/** Parse a positive rational "p/q" (or bare integer "p") into a Step. */
export function parseStep(text: string): Step {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(text.trim());
  if (!m) throw new SyntaxError(`invalid step "${text}", expected p/q with positive integers`);
  const p = BigInt(m[1]!);
  const q = m[2] !== undefined ? BigInt(m[2]) : 1n;
  if (p <= 0n) throw new RangeError(`step "${text}": numerator must be >= 1`);
  if (q <= 0n) throw new RangeError(`step "${text}": denominator must be >= 1`);
  return { p, q };
}

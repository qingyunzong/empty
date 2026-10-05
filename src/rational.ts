/**
 * Exact rational numbers backed by bigint, always kept in normal form:
 * denominator > 0 and gcd(|n|, d) = 1. Zero is 0/1.
 */
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

const babs = (x: bigint): bigint => (x < 0n ? -x : x);

function bgcd(a: bigint, b: bigint): bigint {
  a = babs(a);
  b = babs(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function rat(n: bigint | number, d: bigint | number = 1): Rational {
  let num = BigInt(n);
  let den = BigInt(d);
  if (den === 0n) throw new RangeError("rational with zero denominator");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = bgcd(num, den) || 1n;
  return { n: num / g, d: den / g };
}

export const ZERO: Rational = rat(0);
export const ONE: Rational = rat(1);

export const neg = (a: Rational): Rational => ({ n: -a.n, d: a.d });
export const abs = (a: Rational): Rational => ({ n: babs(a.n), d: a.d });

export const add = (a: Rational, b: Rational): Rational =>
  rat(a.n * b.d + b.n * a.d, a.d * b.d);

export const sub = (a: Rational, b: Rational): Rational =>
  rat(a.n * b.d - b.n * a.d, a.d * b.d);

export const mul = (a: Rational, b: Rational): Rational =>
  rat(a.n * b.n, a.d * b.d);

export const div = (a: Rational, b: Rational): Rational => {
  if (b.n === 0n) throw new RangeError("division by zero rational");
  return rat(a.n * b.d, a.d * b.n);
};

/** Scale by an integer. */
export const scale = (a: Rational, k: bigint): Rational => rat(a.n * k, a.d);

export function cmp(a: Rational, b: Rational): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export const eq = (a: Rational, b: Rational): boolean =>
  a.n === b.n && a.d === b.d;

export const sign = (a: Rational): number => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);

export const min = (a: Rational, b: Rational): Rational => (cmp(a, b) <= 0 ? a : b);
export const max = (a: Rational, b: Rational): Rational => (cmp(a, b) >= 0 ? a : b);

export const clamp = (x: Rational, lo: Rational, hi: Rational): Rational =>
  min(max(x, lo), hi);

/** floor(a / b) as a bigint; b must be non-zero. */
export function floorDiv(a: Rational, b: Rational): bigint {
  if (b.n === 0n) throw new RangeError("floorDiv by zero");
  const p = a.n * b.d;
  const m = a.d * b.n; // may be negative; floor handles the sign
  const q = p / m;
  return p % m !== 0n && (p < 0n) !== (m < 0n) ? q - 1n : q;
}

/** a - b * floor(a / b); b must be positive, result lies in [0, b). */
export function mod(a: Rational, b: Rational): Rational {
  if (b.n <= 0n) throw new RangeError("mod requires a positive divisor");
  return sub(a, scale(b, floorDiv(a, b)));
}

export const toNumber = (a: Rational): number => Number(a.n) / Number(a.d);

export const key = (a: Rational): string => `${a.n}/${a.d}`;

export function toString(a: Rational): string {
  return a.d === 1n ? `${a.n}` : `${a.n}/${a.d}`;
}

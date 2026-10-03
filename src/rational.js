// Exact rational arithmetic on BigInt. Rationals are kept normalized:
// denominator > 0, gcd(|n|, d) = 1.

export function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function rat(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (d === 0n) throw new Error('division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

export const ZERO = Object.freeze({ n: 0n, d: 1n });

export const add = (x, y) => rat(x.n * y.d + y.n * x.d, x.d * y.d);
export const sub = (x, y) => rat(x.n * y.d - y.n * x.d, x.d * y.d);
export const mul = (x, y) => rat(x.n * y.n, x.d * y.d);
export const div = (x, y) => rat(x.n * y.d, x.d * y.n);
export const neg = (x) => rat(-x.n, x.d);
export const abs = (x) => (x.n < 0n ? rat(-x.n, x.d) : x);

export function cmp(x, y) {
  const lhs = x.n * y.d;
  const rhs = y.n * x.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export const eq = (x, y) => x.n === y.n && x.d === y.d;

// Round to integer cents (1/100), half away from zero. Returns BigInt cents.
export function toCentsRounded(x) {
  const sign = x.n < 0n ? -1n : 1n;
  const num = (x.n < 0n ? -x.n : x.n) * 100n;
  const q = num / x.d;
  const rem = num % x.d;
  const rounded = rem * 2n >= x.d ? q + 1n : q;
  return sign * rounded;
}

export const fromCents = (c) => rat(BigInt(c), 100n);

export const toString = (x) => (x.d === 1n ? `${x.n}` : `${x.n}/${x.d}`);
export const toJSON = (x) => ({ n: x.n.toString(), d: x.d.toString() });
export const fromJSON = (o) => rat(BigInt(o.n), BigInt(o.d));

// Exact rational arithmetic on BigInt. Rationals are immutable { n, d } pairs,
// always normalized: d > 0 and gcd(|n|, d) = 1.

export function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

export function rat(num, den = 1n) {
  num = BigInt(num);
  den = BigInt(den);
  if (den === 0n) throw new RangeError('rational with zero denominator');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { n: num / g, d: den / g };
}

export const ZERO = Object.freeze({ n: 0n, d: 1n });
export const ONE = Object.freeze({ n: 1n, d: 1n });

export function add(a, b) {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a, b) {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function cmp(a, b) {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function isZero(a) {
  return a.n === 0n;
}

export function fmt(a) {
  return `${a.n}/${a.d}`;
}

// Parses "n", "n/d", or { num, den } into a normalized rational.
export function parseRat(value) {
  if (value !== null && typeof value === 'object') {
    return rat(value.num ?? value.n, value.den ?? value.d ?? 1n);
  }
  const s = String(value).trim();
  const parts = s.split('/');
  if (parts.length === 1) return rat(BigInt(parts[0]), 1n);
  if (parts.length === 2) return rat(BigInt(parts[0]), BigInt(parts[1]));
  throw new SyntaxError(`cannot parse rational: ${s}`);
}

// Exact rational arithmetic on BigInt. A rational is a frozen plain object
// { n: BigInt, d: BigInt } kept in lowest terms with d > 0.

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

export function R(num, den = 1n) {
  num = BigInt(num);
  den = BigInt(den);
  if (den === 0n) throw new Error('division by zero');
  if (num === 0n) return Object.freeze({ n: 0n, d: 1n });
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return Object.freeze({ n: num / g, d: den / g });
}

export const ZERO = R(0n);
export const ONE = R(1n);

export const add = (a, b) => R(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => R(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a, b) => R(a.n * b.n, a.d * b.d);
export const div = (a, b) => R(a.n * b.d, a.d * b.n);
export const neg = (a) => R(-a.n, a.d);
export const abs = (a) => (a.n < 0n ? R(-a.n, a.d) : a);
export const eq = (a, b) => a.n === b.n && a.d === b.d;
export const isZero = (a) => a.n === 0n;
export function cmp(a, b) {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function toString(r) {
  return r.d === 1n ? `${r.n}` : `${r.n}/${r.d}`;
}

// Parses "p/q", integers and finite decimals ("12.34") exactly.
export function parseDecimal(str) {
  str = String(str).trim();
  let m;
  if ((m = /^([+-]?\d+)\/(\d+)$/.exec(str))) return R(BigInt(m[1]), BigInt(m[2]));
  if ((m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(str))) {
    const frac = m[3] ?? '';
    const den = 10n ** BigInt(frac.length);
    const v = R(BigInt(m[2] + frac), den);
    return m[1] === '-' ? neg(v) : v;
  }
  throw new Error(`bad number: ${JSON.stringify(str)}`);
}

// Parses a num/den field pair (JSON number or string) into one rational.
export function parseNumDen(num, den = 1) {
  const toRat = (x) => {
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new Error(`non-finite number`);
      return parseDecimal(String(x));
    }
    if (typeof x === 'string') return parseDecimal(x);
    if (typeof x === 'bigint') return R(x);
    throw new Error(`expected number or string, got ${typeof x}`);
  };
  return div(toRat(num), toRat(den));
}

// Bankers rounding (round half to even) to `decimals` decimal places.
// Returns the rounded value, the exact error |v - rounded| and the
// worst-case bound 1/(2*10^decimals).
export function roundHalfEven(v, decimals = 2) {
  const scale = 10n ** BigInt(decimals);
  const sign = v.n < 0n ? -1n : 1n;
  const an = v.n < 0n ? -v.n : v.n;
  const num = an * scale;
  const den = v.d;
  let q = num / den; // floor, since both operands are non-negative
  const r = num % den;
  const twice = 2n * r;
  if (twice > den) q += 1n;
  else if (twice === den && (q & 1n) === 1n) q += 1n; // tie: round to even
  const rounded = R(sign * q, scale);
  return {
    rounded,
    error: abs(sub(v, rounded)),
    bound: R(1n, 2n * scale),
  };
}

// Fixed-point decimal string with exactly `decimals` places (half-even).
export function formatDecimal(r, decimals = 2) {
  const { rounded } = roundHalfEven(r, decimals);
  const scale = 10n ** BigInt(decimals);
  const negative = rounded.n < 0n;
  const an = negative ? -rounded.n : rounded.n;
  const scaled = an * (scale / rounded.d); // rounded.d divides scale
  const s = scaled.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = decimals > 0 ? '.' + s.slice(s.length - decimals) : '';
  return (negative ? '-' : '') + intPart + fracPart;
}

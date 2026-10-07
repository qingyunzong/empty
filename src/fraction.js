// Exact rational arithmetic on BigInt. All fractions are kept normalized:
// den > 0 and gcd(|num|, den) === 1n.

export function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function frac(num, den = 1n) {
  num = BigInt(num);
  den = BigInt(den);
  if (den === 0n) throw new Error('E_DEN_ZERO');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export const ZERO = Object.freeze({ num: 0n, den: 1n });
export const ONE = Object.freeze({ num: 1n, den: 1n });

export function add(a, b) {
  return frac(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a, b) {
  return frac(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a, b) {
  return frac(a.num * b.num, a.den * b.den);
}

export function div(a, b) {
  if (b.num === 0n) throw new Error('E_DIV_ZERO');
  return frac(a.num * b.den, a.den * b.num);
}

export function neg(a) {
  return { num: -a.num, den: a.den };
}

export function cmp(a, b) {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function eq(a, b) {
  return a.num === b.num && a.den === b.den;
}

export function isZero(a) {
  return a.num === 0n;
}

// Mathematical floor of a rational (den > 0), returned as BigInt.
export function floorFrac(f) {
  let q = f.num / f.den;
  if (f.num % f.den !== 0n && f.num < 0n) q -= 1n;
  return q;
}

export function fracFromInt(v) {
  return { num: BigInt(v), den: 1n };
}

export function fracToString(f) {
  return f.den === 1n ? f.num.toString() : `${f.num}/${f.den}`;
}

// Exact rational arithmetic on BigInt. All fractions are kept normalized:
// gcd(|num|, den) == 1 and den > 0.
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
  if (den === 0n) throw new Error('E_FRAC: zero denominator');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}

export const ZERO = Object.freeze({ num: 0n, den: 1n });

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
  if (b.num === 0n) throw new Error('E_FRAC: division by zero');
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

export function toString(a) {
  return a.den === 1n ? a.num.toString() : `${a.num}/${a.den}`;
}

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function make(num: bigint, den: bigint = 1n): Rational {
  if (den === 0n) throw new Error("rational with zero denominator");
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { num: n / g, den: d / g };
}

export function parse(text: string): Rational {
  const t = text.trim();
  if (t.length === 0) throw new Error("empty rational literal");
  if (t.includes("/")) {
    const parts = t.split("/");
    if (parts.length !== 2) throw new Error(`bad rational literal: ${text}`);
    return make(BigInt(parts[0].trim()), BigInt(parts[1].trim()));
  }
  if (t.includes(".")) {
    const negative = t.startsWith("-");
    const body = negative ? t.slice(1) : t;
    const parts = body.split(".");
    if (parts.length !== 2) throw new Error(`bad decimal literal: ${text}`);
    const intPart = parts[0] === "" ? 0n : BigInt(parts[0]);
    const fracPart = parts[1] === "" ? 0n : BigInt(parts[1]);
    const den = 10n ** BigInt(parts[1].length);
    const num = intPart * den + fracPart;
    return make(negative ? -num : num, den);
  }
  return make(BigInt(t));
}

export function add(a: Rational, b: Rational): Rational {
  return make(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Rational, b: Rational): Rational {
  return make(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return make(a.num * b.num, a.den * b.den);
}

export function neg(a: Rational): Rational {
  return { num: -a.num, den: a.den };
}

export function abs(a: Rational): Rational {
  return a.num < 0n ? { num: -a.num, den: a.den } : a;
}

export function cmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function eq(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den;
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function toString(a: Rational): string {
  return a.den === 1n ? a.num.toString() : `${a.num}/${a.den}`;
}

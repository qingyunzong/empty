/** Exact rational number backed by bigint, always normalized (den > 0, gcd-reduced). */
export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den: bigint = 1n) {
    if (den === 0n) throw new Error("Rational: zero denominator");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(abs(num), den);
    this.num = num / g;
    this.den = den / g;
  }

  static of(num: bigint | number, den: bigint | number = 1): Rational {
    return new Rational(BigInt(num), BigInt(den));
  }

  add(other: Rational): Rational {
    return new Rational(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other: Rational): Rational {
    return new Rational(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other: Rational): Rational {
    return new Rational(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    if (other.num === 0n) throw new Error("Rational: division by zero");
    return new Rational(this.num * other.den, this.den * other.num);
  }

  neg(): Rational {
    return new Rational(-this.num, this.den);
  }

  /** -1, 0, 1 */
  cmp(other: Rational): number {
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.num === other.num && this.den === other.den;
  }

  sign(): number {
    return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
  }

  toString(): string {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

/** Floor of a rational as bigint. */
export function floorRational(r: Rational): bigint {
  let q = r.num / r.den;
  if (r.num % r.den !== 0n && r.num < 0n) q -= 1n;
  return q;
}

/** Ceiling of a rational as bigint. */
export function ceilRational(r: Rational): bigint {
  return -floorRational(r.neg());
}

/** Round a rational to the nearest integer, ties to even (banker's rounding). */
export function roundHalfEven(r: Rational): bigint {
  const q = floorRational(r);
  const rem = r.num - q * r.den; // 0 <= rem < den
  const twice = rem * 2n;
  if (twice < r.den) return q;
  if (twice > r.den) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}

const bigAbs = (x: bigint): bigint => (x < 0n ? -x : x);

function bigGcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/** Exact rational number backed by BigInt, always kept in lowest terms with den > 0. */
export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number | Rational, den: bigint | number = 1): Rational {
    if (num instanceof Rational) {
      if (den === 1 || den === 1n) return num;
      return num.div(Rational.of(den));
    }
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new RangeError("Rational: denominator must be non-zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = bigGcd(n, d);
    return new Rational(n / g, d / g);
  }

  static zero(): Rational {
    return Rational.of(0);
  }

  /** Approximate a float as a rational with the given denominator. For the numerical reference model only. */
  static approx(value: number, den: bigint | number = 1_000_000_000): Rational {
    const d = BigInt(den);
    return Rational.of(BigInt(Math.round(value * Number(d))), d);
  }

  static parse(text: string): Rational {
    const trimmed = text.trim();
    const slash = trimmed.indexOf("/");
    if (slash < 0) return Rational.of(BigInt(trimmed));
    const n = BigInt(trimmed.slice(0, slash));
    const d = BigInt(trimmed.slice(slash + 1));
    return Rational.of(n, d);
  }

  add(other: Rational): Rational {
    return Rational.of(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other: Rational): Rational {
    return Rational.of(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other: Rational): Rational {
    return Rational.of(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    if (other.num === 0n) throw new RangeError("Rational: division by zero");
    return Rational.of(this.num * other.den, this.den * other.num);
  }

  neg(): Rational {
    return Rational.of(-this.num, this.den);
  }

  cmp(other: Rational): number {
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.num === other.num && this.den === other.den;
  }

  isNegative(): boolean {
    return this.num < 0n;
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

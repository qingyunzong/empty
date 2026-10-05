/**
 * Exact rational numbers backed by BigInt, always kept in lowest terms
 * with a strictly positive denominator.
 */
export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number, den: bigint | number = 1): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error("Rational: zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(abs(n), d);
    return new Rational(n / g, d / g);
  }

  static readonly ZERO = Rational.of(0);
  static readonly ONE = Rational.of(1);

  add(o: Rational): Rational {
    return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }
  sub(o: Rational): Rational {
    return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }
  mul(o: Rational): Rational {
    return Rational.of(this.num * o.num, this.den * o.den);
  }
  div(o: Rational): Rational {
    if (o.num === 0n) throw new Error("Rational: division by zero");
    return Rational.of(this.num * o.den, this.den * o.num);
  }
  neg(): Rational {
    return Rational.of(-this.num, this.den);
  }
  abs(): Rational {
    return this.num < 0n ? this.neg() : this;
  }

  cmp(o: Rational): number {
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  lt(o: Rational): boolean { return this.cmp(o) < 0; }
  le(o: Rational): boolean { return this.cmp(o) <= 0; }
  eq(o: Rational): boolean { return this.cmp(o) === 0; }
  ge(o: Rational): boolean { return this.cmp(o) >= 0; }
  gt(o: Rational): boolean { return this.cmp(o) > 0; }

  isZero(): boolean { return this.num === 0n; }
  sign(): number { return this.num < 0n ? -1 : this.num > 0n ? 1 : 0; }

  min(o: Rational): Rational { return this.le(o) ? this : o; }
  max(o: Rational): Rational { return this.ge(o) ? this : o; }

  toString(): string {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }
  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
}

function abs(a: bigint): bigint { return a < 0n ? -a : a; }

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

/** Convenience constructor. */
export function rat(num: bigint | number, den: bigint | number = 1): Rational {
  return Rational.of(num, den);
}

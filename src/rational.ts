export type RationalInput = Rational | bigint | number;

function toBigInt(value: bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  throw new Error(`cannot convert ${String(value)} to a rational component`);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x === 0n ? 1n : x;
}

export class Rational {
  private constructor(
    readonly num: bigint,
    readonly den: bigint,
  ) {}

  private static raw(num: bigint, den: bigint): Rational {
    if (den === 0n) throw new Error("rational with zero denominator");
    let n = num;
    let d = den;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return new Rational(n / g, d / g);
  }

  static wrap(value: RationalInput): Rational {
    if (value instanceof Rational) return value;
    return Rational.raw(toBigInt(value), 1n);
  }

  static of(numerator: RationalInput, denominator: RationalInput = 1): Rational {
    return Rational.wrap(numerator).div(Rational.wrap(denominator));
  }

  add(other: RationalInput): Rational {
    const r = Rational.wrap(other);
    return Rational.raw(this.num * r.den + r.num * this.den, this.den * r.den);
  }

  sub(other: RationalInput): Rational {
    const r = Rational.wrap(other);
    return Rational.raw(this.num * r.den - r.num * this.den, this.den * r.den);
  }

  mul(other: RationalInput): Rational {
    const r = Rational.wrap(other);
    return Rational.raw(this.num * r.num, this.den * r.den);
  }

  div(other: RationalInput): Rational {
    const r = Rational.wrap(other);
    return Rational.raw(this.num * r.den, this.den * r.num);
  }

  neg(): Rational {
    return Rational.raw(-this.num, this.den);
  }

  abs(): Rational {
    return this.num < 0n ? this.neg() : this;
  }

  sign(): number {
    if (this.num === 0n) return 0;
    return this.num < 0n ? -1 : 1;
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  cmp(other: RationalInput): number {
    const r = Rational.wrap(other);
    const left = this.num * r.den;
    const right = r.num * this.den;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  equals(other: RationalInput): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: RationalInput): boolean {
    return this.cmp(other) < 0;
  }

  le(other: RationalInput): boolean {
    return this.cmp(other) <= 0;
  }

  gt(other: RationalInput): boolean {
    return this.cmp(other) > 0;
  }

  ge(other: RationalInput): boolean {
    return this.cmp(other) >= 0;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }

  toString(): string {
    if (this.den === 1n) return this.num.toString();
    return `${this.num}/${this.den}`;
  }

  static min(a: Rational, b: Rational): Rational {
    return a.le(b) ? a : b;
  }

  static max(a: Rational, b: Rational): Rational {
    return a.ge(b) ? a : b;
  }
}

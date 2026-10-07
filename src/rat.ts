/**
 * Exact rational numbers backed by BigInt, always kept in lowest terms
 * with a strictly positive denominator.
 */

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

export class Rat {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number | string, den: bigint | number | string = 1n): Rat {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error("Rat: zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return new Rat(n / g, d / g);
  }

  static readonly ZERO: Rat = Rat.of(0n);
  static readonly ONE: Rat = Rat.of(1n);

  isZero(): boolean {
    return this.num === 0n;
  }

  sign(): -1 | 0 | 1 {
    return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
  }

  add(o: Rat): Rat {
    return Rat.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Rat): Rat {
    return Rat.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o: Rat): Rat {
    return Rat.of(this.num * o.num, this.den * o.den);
  }

  div(o: Rat): Rat {
    if (o.num === 0n) throw new Error("Rat: division by zero");
    return Rat.of(this.num * o.den, this.den * o.num);
  }

  neg(): Rat {
    return Rat.of(-this.num, this.den);
  }

  abs(): Rat {
    return this.num < 0n ? this.neg() : this;
  }

  cmp(o: Rat): -1 | 0 | 1 {
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }

  lt(o: Rat): boolean {
    return this.cmp(o) < 0;
  }
  le(o: Rat): boolean {
    return this.cmp(o) <= 0;
  }
  gt(o: Rat): boolean {
    return this.cmp(o) > 0;
  }
  ge(o: Rat): boolean {
    return this.cmp(o) >= 0;
  }
  eq(o: Rat): boolean {
    return this.num === o.num && this.den === o.den;
  }

  static min(a: Rat, b: Rat): Rat {
    return a.le(b) ? a : b;
  }
  static max(a: Rat, b: Rat): Rat {
    return a.ge(b) ? a : b;
  }

  /** Exact midpoint. */
  mid(o: Rat): Rat {
    return this.add(o).div(Rat.of(2n));
  }

  toString(): string {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }

  /** Lossy double approximation, for display/debug only. */
  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
}

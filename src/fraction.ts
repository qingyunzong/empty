function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcdBig(a: bigint, b: bigint): bigint {
  a = absBig(a);
  b = absBig(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

/** Exact rational number backed by BigInt, always kept in lowest terms. */
export class Fraction {
  private constructor(
    readonly num: bigint,
    readonly den: bigint,
  ) {}

  static of(num: bigint | number, den: bigint | number = 1): Fraction {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error("fraction with zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcdBig(n, d);
    return new Fraction(n / g, d / g);
  }

  static readonly ZERO = Fraction.of(0);
  static readonly ONE = Fraction.of(1);

  isZero(): boolean {
    return this.num === 0n;
  }

  sign(): -1 | 0 | 1 {
    return this.num > 0n ? 1 : this.num < 0n ? -1 : 0;
  }

  neg(): Fraction {
    return new Fraction(-this.num, this.den);
  }

  abs(): Fraction {
    return this.num < 0n ? new Fraction(-this.num, this.den) : this;
  }

  add(o: Fraction): Fraction {
    return Fraction.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Fraction): Fraction {
    return Fraction.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o: Fraction): Fraction {
    return Fraction.of(this.num * o.num, this.den * o.den);
  }

  div(o: Fraction): Fraction {
    if (o.num === 0n) throw new Error("division by zero fraction");
    return Fraction.of(this.num * o.den, this.den * o.num);
  }

  equals(o: Fraction): boolean {
    return this.num === o.num && this.den === o.den;
  }

  cmp(o: Fraction): number {
    const lhs = this.num * o.den;
    const rhs = o.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

export function gcdBig(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function lcmBig(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcdBig(a, b)) * b;
}

/** floor(a / b) for b > 0, exact for negative a. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** ceil(a / b) for b > 0, exact for negative a. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

/** Immutable exact rational number, always normalized (den > 0, gcd(|num|, den) = 1). */
export class Rational {
  private constructor(
    readonly num: bigint,
    readonly den: bigint,
  ) {}

  static of(num: bigint, den: bigint = 1n): Rational {
    if (den === 0n) throw new Error("rational with zero denominator");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcdBig(num, den);
    return new Rational(num / g, den / g);
  }

  static from(value: number | bigint | string | Rational): Rational {
    if (value instanceof Rational) return value;
    if (typeof value === "bigint") return Rational.of(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
      return Rational.parse(String(value));
    }
    return Rational.parse(value);
  }

  /** Accepts "p/q", integers, and decimals (optionally with exponent), e.g. "3/4", "-2", "0.125", "1.5e-3". */
  static parse(text: string): Rational {
    const t = text.trim();
    const frac = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(t);
    if (frac) return Rational.of(BigInt(frac[1]), BigInt(frac[2]));
    const dec = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(t);
    if (dec) {
      const [, sign, intPart, fracPart, expPart] = dec;
      let num = BigInt(intPart + (fracPart ?? ""));
      let den = 10n ** BigInt((fracPart ?? "").length);
      if (expPart !== undefined) {
        const e = BigInt(expPart);
        if (e >= 0n) num *= 10n ** e;
        else den *= 10n ** -e;
      }
      if (sign === "-") num = -num;
      return Rational.of(num, den);
    }
    throw new Error(`invalid rational literal: ${JSON.stringify(text)}`);
  }

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
    if (o.num === 0n) throw new Error("division by zero rational");
    return Rational.of(this.num * o.den, this.den * o.num);
  }

  neg(): Rational {
    return Rational.of(-this.num, this.den);
  }

  cmp(o: Rational): number {
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }

  eq(o: Rational): boolean {
    return this.num === o.num && this.den === o.den;
  }

  lt(o: Rational): boolean {
    return this.cmp(o) < 0;
  }

  le(o: Rational): boolean {
    return this.cmp(o) <= 0;
  }

  gt(o: Rational): boolean {
    return this.cmp(o) > 0;
  }

  ge(o: Rational): boolean {
    return this.cmp(o) >= 0;
  }

  floor(): bigint {
    return floorDiv(this.num, this.den);
  }

  ceil(): bigint {
    return ceilDiv(this.num, this.den);
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
}

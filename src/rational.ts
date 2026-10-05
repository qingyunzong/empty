/**
 * Exact rational arithmetic on BigInt. No floating point is ever involved:
 * every value is a normalized fraction num/den with den > 0 and
 * gcd(|num|, den) = 1. All comparisons are exact.
 */

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static readonly ZERO = new Rational(0n, 1n);
  static readonly ONE = new Rational(1n, 1n);

  static fromBigInt(num: bigint, den: bigint = 1n): Rational {
    if (den === 0n) throw new Error("rational: zero denominator");
    if (num === 0n) return Rational.ZERO;
    let n = num;
    let d = den;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return new Rational(n / g, d / g);
  }

  /**
   * Exact conversion. Accepted inputs:
   *  - Rational: returned as-is
   *  - bigint: exact integer
   *  - number: must be an exact integer (Number.isInteger), otherwise throws.
   *    Non-integer floats are rejected on purpose: silently rounding them
   *    would be exactly the "float tolerance pretending to be exact" anti
   *    pattern this library forbids.
   *  - string: "p/q", integer, or finite decimal ("-3", "7/4", "0.125",
   *    "-2.75"). Decimals are parsed exactly (0.1 === 1/10).
   */
  static of(value: RationalLike): Rational {
    if (value instanceof Rational) return value;
    if (typeof value === "bigint") return Rational.fromBigInt(value);
    if (typeof value === "number") {
      if (!Number.isInteger(value)) {
        throw new Error(
          `rational: non-integer number ${value} is not exactly representable; ` +
            `pass a string like "${value}" or "p/q" instead`,
        );
      }
      return Rational.fromBigInt(BigInt(value));
    }
    if (typeof value === "string") return Rational.parse(value);
    throw new Error(`rational: unsupported input ${String(value)}`);
  }

  static parse(text: string): Rational {
    const s = text.trim();
    const frac = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(s);
    if (frac) return Rational.fromBigInt(BigInt(frac[1]!), BigInt(frac[2]!));
    const dec = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(s);
    if (dec && (dec[2] !== "" || dec[3] !== undefined)) {
      const intPart = dec[2] === "" ? "0" : dec[2];
      const fracPart = dec[3] ?? "";
      const digits = intPart + fracPart;
      const scale = 10n ** BigInt(fracPart.length);
      const num = BigInt(digits === "" ? "0" : digits) * (dec[1] === "-" ? -1n : 1n);
      return Rational.fromBigInt(num, scale);
    }
    throw new Error(`rational: cannot parse "${text}"`);
  }

  add(o: Rational): Rational {
    return Rational.fromBigInt(this.num * o.den + o.num * this.den, this.den * o.den);
  }
  sub(o: Rational): Rational {
    return Rational.fromBigInt(this.num * o.den - o.num * this.den, this.den * o.den);
  }
  mul(o: Rational): Rational {
    return Rational.fromBigInt(this.num * o.num, this.den * o.den);
  }
  div(o: Rational): Rational {
    if (o.num === 0n) throw new Error("rational: division by zero");
    return Rational.fromBigInt(this.num * o.den, this.den * o.num);
  }
  neg(): Rational {
    return this.num === 0n ? this : Rational.fromBigInt(-this.num, this.den);
  }
  abs(): Rational {
    return this.num < 0n ? this.neg() : this;
  }

  /** Exact sign: -1, 0 or 1. */
  sign(): number {
    return this.num > 0n ? 1 : this.num < 0n ? -1 : 0;
  }
  /** Exact comparison: -1, 0 or 1. */
  cmp(o: Rational): number {
    const lhs = this.num * o.den;
    const rhs = o.num * this.den;
    return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
  }
  eq(o: Rational): boolean {
    return this.num === o.num && this.den === o.den;
  }
  isZero(): boolean {
    return this.num === 0n;
  }
  isPositive(): boolean {
    return this.num > 0n;
  }
  isNegative(): boolean {
    return this.num < 0n;
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

export type RationalLike = Rational | bigint | number | string;

export const R = (v: RationalLike): Rational => Rational.of(v);

/** Exact dot product. */
export function dot(a: readonly Rational[], b: readonly Rational[]): Rational {
  if (a.length !== b.length) throw new Error("dot: length mismatch");
  let acc = Rational.ZERO;
  for (let i = 0; i < a.length; i++) acc = acc.add(a[i]!.mul(b[i]!));
  return acc;
}

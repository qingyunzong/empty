/** Exact rational numbers backed by BigInt, always kept in lowest terms. */

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
  private constructor(
    readonly num: bigint,
    readonly den: bigint,
  ) {}

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error("rational with zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return new Rational(n / g, d / g);
  }

  static readonly ZERO: Rational = Rational.of(0n);
  static readonly ONE: Rational = Rational.of(1n);

  /** Parses "12", "1.25", ".5", "5.", "1e3", "1.5e-2", "3/4" exactly. */
  static parse(text: string): Rational {
    const frac = /^([+-]?\d+)\/(\d+)$/.exec(text);
    if (frac !== null) return Rational.of(BigInt(frac[1]!), BigInt(frac[2]!));
    const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m || ((m[1] ?? "") === "" && (m[2] ?? "") === "")) {
      throw new Error(`not a numeric literal: ${JSON.stringify(text)}`);
    }
    const digits = (m[1] ?? "") + (m[2] ?? "");
    const fracLen = (m[2] ?? "").length;
    const exp = m[3] !== undefined ? Number.parseInt(m[3], 10) : 0;
    const n = BigInt(digits === "" ? "0" : digits);
    const scale = exp - fracLen;
    if (scale >= 0) return Rational.of(n * 10n ** BigInt(scale));
    return Rational.of(n, 10n ** BigInt(-scale));
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  equals(other: Rational): boolean {
    return this.num === other.num && this.den === other.den;
  }

  neg(): Rational {
    return Rational.of(-this.num, this.den);
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
    if (o.isZero()) throw new Error("division by zero");
    return Rational.of(this.num * o.den, this.den * o.num);
  }

  pow(exp: number): Rational {
    if (!Number.isInteger(exp)) throw new Error("exponent must be an integer");
    if (exp === 0) return Rational.ONE;
    const e = BigInt(exp < 0 ? -exp : exp);
    const n = this.num ** e;
    const d = this.den ** e;
    return exp > 0 ? Rational.of(n, d) : Rational.of(d, n);
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

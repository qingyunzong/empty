/**
 * Exact rational number backed by BigInt, always kept in normalized form
 * (denominator > 0, gcd(|num|, den) = 1). All score arithmetic in this
 * library is exact; nothing is ever rounded through floating point.
 */
export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    if (den === 0n) throw new Error("rational denominator must be non-zero");
    let n = num;
    let d = den;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    this.num = n / g;
    this.den = d / g;
  }

  static of(num: bigint | number, den: bigint | number = 1): Rational {
    return new Rational(BigInt(num), BigInt(den));
  }

  static zero(): Rational {
    return Rational.of(0n);
  }

  /** Parses integers, finite decimals and "num/den" fractions exactly. */
  static from(value: number | bigint | string | Rational): Rational {
    if (value instanceof Rational) return value;
    if (typeof value === "bigint") return Rational.of(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`non-finite value: ${value}`);
      return Rational.from(value.toString());
    }
    const text = value.trim();
    const slash = text.indexOf("/");
    if (slash >= 0) {
      const numText = text.slice(0, slash);
      const denText = text.slice(slash + 1);
      if (!/^-?\d+$/.test(numText) || !/^-?\d+$/.test(denText)) {
        throw new Error(`invalid rational value: ${value}`);
      }
      return new Rational(BigInt(numText), BigInt(denText));
    }
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`invalid numeric value: ${value}`);
    const negative = match[1] === "-";
    const intPart = match[2] as string;
    const fracPart = match[3] ?? "";
    const den = 10n ** BigInt(fracPart.length);
    let num = BigInt(intPart + fracPart);
    if (negative) num = -num;
    return new Rational(num, den);
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
    if (other.num === 0n) throw new Error("division by zero rational");
    return new Rational(this.num * other.den, this.den * other.num);
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  equals(other: Rational): boolean {
    return this.num === other.num && this.den === other.den;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

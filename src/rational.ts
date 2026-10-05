/**
 * Exact rational numbers backed by BigInt, always kept in normal form:
 * den > 0 and gcd(|num|, den) = 1.
 */
export type RationalInput = Rational | bigint | number | string;

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

  static of(value: RationalInput): Rational {
    if (value instanceof Rational) return value;
    if (typeof value === 'bigint') return new Rational(value, 1n);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
      // Convert via the shortest decimal string to keep exactness (0.1 -> 1/10).
      return Rational.parse(String(value));
    }
    return Rational.parse(value);
  }

  /** Parses "p/q", integers, and finite decimals (optionally signed / exponent-free). */
  static parse(text: string): Rational {
    const s = text.trim();
    const frac = /^([+-]?\d+)\/([+-]?\d+)$/.exec(s);
    if (frac) {
      const num = BigInt(frac[1]!);
      const den = BigInt(frac[2]!);
      if (den === 0n) throw new Error(`zero denominator in ${text}`);
      return Rational.normalize(num, den);
    }
    const dec = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(s);
    if (dec && (dec[2] !== '' || dec[3] !== undefined)) {
      const intPart = dec[2] === '' ? '0' : dec[2]!;
      const fracPart = dec[3] ?? '';
      const digits = intPart + fracPart;
      const scale = 10n ** BigInt(fracPart.length);
      const num = BigInt((dec[1] === '-' ? '-' : '') + digits);
      return Rational.normalize(num, scale);
    }
    throw new Error(`cannot parse rational: ${text}`);
  }

  private static normalize(num: bigint, den: bigint): Rational {
    if (den === 0n) throw new Error('zero denominator');
    const sign = den < 0n ? -1n : 1n;
    const g = gcd(num, den);
    return new Rational((sign * num) / g, (sign * den) / g);
  }

  compare(other: RationalInput): number {
    const o = Rational.of(other);
    const lhs = this.num * o.den;
    const rhs = o.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  equals(other: RationalInput): boolean {
    return this.compare(other) === 0;
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

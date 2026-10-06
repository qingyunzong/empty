import { gcd } from './bigint-util.js';

export type RationalInput = Rational | bigint | number | string;

/** Exact rational number backed by BigInt, always kept in lowest terms with den > 0. */
export class Rational {
  private constructor(
    public readonly num: bigint,
    public readonly den: bigint,
  ) {}

  static make(num: bigint, den: bigint = 1n): Rational {
    if (den === 0n) throw new RangeError('rational with zero denominator');
    if (num === 0n) return new Rational(0n, 1n);
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    return new Rational(num / g, den / g);
  }

  static from(input: RationalInput): Rational {
    if (input instanceof Rational) return input;
    if (typeof input === 'bigint') return Rational.make(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new RangeError(`not a finite number: ${input}`);
      return Rational.from(String(input));
    }
    const s = input.trim();
    const frac = /^([+-]?\d+)\/([+-]?\d+)$/.exec(s);
    if (frac) return Rational.make(BigInt(frac[1]!), BigInt(frac[2]!));
    const dec = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(s);
    if (dec && (dec[2] !== '' || dec[3] !== undefined)) {
      const sign = dec[1] === '-' ? -1n : 1n;
      const intPart = dec[2] === '' ? '0' : dec[2]!;
      const fracPart = dec[3] ?? '';
      const den = 10n ** BigInt(fracPart.length);
      const num = BigInt(intPart) * den + (fracPart === '' ? 0n : BigInt(fracPart));
      return Rational.make(sign * num, den);
    }
    throw new Error(`cannot parse rational: ${JSON.stringify(input)}`);
  }

  add(o: RationalInput): Rational {
    const r = Rational.from(o);
    return Rational.make(this.num * r.den + r.num * this.den, this.den * r.den);
  }

  sub(o: RationalInput): Rational {
    const r = Rational.from(o);
    return Rational.make(this.num * r.den - r.num * this.den, this.den * r.den);
  }

  mul(o: RationalInput): Rational {
    const r = Rational.from(o);
    return Rational.make(this.num * r.num, this.den * r.den);
  }

  div(o: RationalInput): Rational {
    const r = Rational.from(o);
    if (r.num === 0n) throw new RangeError('division by zero');
    return Rational.make(this.num * r.den, this.den * r.num);
  }

  neg(): Rational {
    return Rational.make(-this.num, this.den);
  }

  abs(): Rational {
    return this.num < 0n ? this.neg() : this;
  }

  sign(): -1 | 0 | 1 {
    return this.num > 0n ? 1 : this.num < 0n ? -1 : 0;
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  cmp(o: RationalInput): number {
    const r = Rational.from(o);
    const d = this.num * r.den - r.num * this.den;
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  }

  eq(o: RationalInput): boolean {
    return this.cmp(o) === 0;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

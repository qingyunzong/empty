export type RationalLike = Fraction | bigint | number | string;

export function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return a === 0n ? 1n : a;
}

/** Exact integer square root: floor(sqrt(n)) for n >= 0. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt: negative input");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

const INT_RE = /^([+-]?\d+)(?:\/(\d+))?$/;
const DEC_RE = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Exact rational number backed by BigInt numerator/denominator (den > 0, normalized). */
export class Fraction {
  static readonly ZERO = new Fraction(0n, 1n);
  static readonly ONE = new Fraction(1n, 1n);
  static readonly TWO = new Fraction(2n, 1n);

  private constructor(
    public readonly num: bigint,
    public readonly den: bigint,
  ) {}

  static fromParts(num: bigint, den: bigint): Fraction {
    if (den === 0n) throw new Error("Fraction: zero denominator");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    return new Fraction(num / g, den / g);
  }

  /**
   * Accepts a Fraction, bigint, integer/decimal number, or a string of the
   * form "p/q", "p", "p.q", "1.5e-3". Numbers are converted exactly via
   * their decimal string representation.
   */
  static of(value: RationalLike): Fraction {
    if (value instanceof Fraction) return value;
    if (typeof value === "bigint") return Fraction.fromParts(value, 1n);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`Fraction: not finite: ${value}`);
      return Fraction.of(value.toString());
    }
    const s = value.trim();
    const ints = INT_RE.exec(s);
    if (ints) return Fraction.fromParts(BigInt(ints[1]), ints[2] ? BigInt(ints[2]) : 1n);
    const dec = DEC_RE.exec(s);
    if (dec && (dec[2] !== "" || dec[3] !== undefined)) {
      const digits = (dec[2] ?? "") + (dec[3] ?? "");
      let num = BigInt((dec[1] === "-" ? "-" : "") + digits);
      let den = 10n ** BigInt((dec[3] ?? "").length);
      const exp = dec[4] ? BigInt(dec[4]) : 0n;
      if (exp >= 0n) num *= 10n ** exp;
      else den *= 10n ** -exp;
      return Fraction.fromParts(num, den);
    }
    throw new Error(`Fraction: cannot parse ${JSON.stringify(value)}`);
  }

  get isZero(): boolean {
    return this.num === 0n;
  }

  sign(): number {
    return this.num === 0n ? 0 : this.num > 0n ? 1 : -1;
  }

  add(o: Fraction): Fraction {
    return Fraction.fromParts(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Fraction): Fraction {
    return Fraction.fromParts(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o: Fraction): Fraction {
    return Fraction.fromParts(this.num * o.num, this.den * o.den);
  }

  div(o: Fraction): Fraction {
    if (o.num === 0n) throw new Error("Fraction: division by zero");
    return Fraction.fromParts(this.num * o.den, this.den * o.num);
  }

  neg(): Fraction {
    return new Fraction(-this.num, this.den);
  }

  abs(): Fraction {
    return this.num < 0n ? this.neg() : this;
  }

  cmp(o: Fraction): number {
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  equals(o: Fraction): boolean {
    return this.cmp(o) === 0;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  static min(a: Fraction, b: Fraction): Fraction {
    return a.cmp(b) <= 0 ? a : b;
  }

  static max(a: Fraction, b: Fraction): Fraction {
    return a.cmp(b) >= 0 ? a : b;
  }
}

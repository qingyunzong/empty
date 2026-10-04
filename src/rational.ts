/** Exact rational number backed by BigInt, always kept in lowest terms. */
export class Rational {
  readonly num: bigint;
  readonly den: bigint; // always > 0

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error("rational with zero denominator");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(abs(n), d);
    return new Rational(n / g, d / g);
  }

  static readonly ZERO = Rational.of(0n);
  static readonly ONE = Rational.of(1n);

  /** Parse a decimal literal like "12", "3.14", "1e-3", "2.5E2" exactly. */
  static parse(text: string): Rational {
    const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m) throw new Error(`invalid number literal: ${text}`);
    const intPart = m[1]!;
    const fracPart = m[2] ?? "";
    const exp = m[3] ? BigInt(m[3]) : 0n;
    let num = BigInt(intPart + fracPart);
    let den = 10n ** BigInt(fracPart.length);
    if (exp >= 0n) num *= 10n ** exp;
    else den *= 10n ** -exp;
    return Rational.of(num, den);
  }

  get isZero(): boolean { return this.num === 0n; }
  get isInteger(): boolean { return this.den === 1n; }
  get sign(): number { return this.num > 0n ? 1 : this.num < 0n ? -1 : 0; }

  add(o: Rational): Rational { return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o: Rational): Rational { return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o: Rational): Rational { return Rational.of(this.num * o.num, this.den * o.den); }
  div(o: Rational): Rational {
    if (o.isZero) throw new Error("division by zero");
    return Rational.of(this.num * o.den, this.den * o.num);
  }
  neg(): Rational { return Rational.of(-this.num, this.den); }

  pow(exp: number): Rational {
    if (!Number.isSafeInteger(exp)) throw new Error("exponent out of range");
    if (exp === 0) return Rational.ONE;
    const e = BigInt(Math.abs(exp));
    const n = this.num ** e;
    const d = this.den ** e;
    return exp > 0 ? Rational.of(n, d) : Rational.of(d, n);
  }

  equals(o: Rational): boolean { return this.num === o.num && this.den === o.den; }
  compare(o: Rational): number {
    const d = this.num * o.den - o.num * this.den;
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  }

  /** Exact form: "3", "-7/2". */
  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

function abs(x: bigint): bigint { return x < 0n ? -x : x; }
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}

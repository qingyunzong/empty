/** Exact rational number backed by bigint, used as fractional evidence. */
export class Fraction {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint | number, den: bigint | number = 1) {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error("Fraction: denominator must not be 0");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(abs(n), d);
    this.num = n / g;
    this.den = d / g;
  }

  static zero(): Fraction {
    return new Fraction(0);
  }

  mul(other: Fraction | number | bigint): Fraction {
    const o = toFraction(other);
    return new Fraction(this.num * o.num, this.den * o.den);
  }

  add(other: Fraction | number | bigint): Fraction {
    const o = toFraction(other);
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  cmp(other: Fraction | number | bigint): number {
    const o = toFraction(other);
    const lhs = this.num * o.den;
    const rhs = o.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  /** Greatest integer <= this fraction. */
  floor(): bigint {
    const q = this.num / this.den;
    return this.num % this.den !== 0n && this.num < 0n ? q - 1n : q;
  }

  isInteger(): boolean {
    return this.den === 1n;
  }

  toString(): string {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
}

function toFraction(value: Fraction | number | bigint): Fraction {
  return value instanceof Fraction ? value : new Fraction(value);
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
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

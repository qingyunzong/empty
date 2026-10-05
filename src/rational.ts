/**
 * 精确有理数(基于 BigInt),用于输出无可舍入误差的“分数证据”。
 * 仅使用 Node.js 内置能力,无第三方依赖。
 */
export class Rat {
  private constructor(
    public readonly num: bigint,
    public readonly den: bigint,
  ) {}

  static of(value: number | bigint | string): Rat {
    if (typeof value === 'bigint') return Rat.fromBigInts(value, 1n);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`非有限数值: ${value}`);
      return Rat.of(value.toString());
    }
    const text = value.trim();
    const frac = /^(-?\d+)\/(\d+)$/.exec(text);
    if (frac) return Rat.fromBigInts(BigInt(frac[1]), BigInt(frac[2]));
    const match = /^(-?\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) throw new Error(`无法解析数值: ${value}`);
    const intPart = match[1];
    const fracPart = match[2] ?? '';
    const exp = Number(match[3] ?? '0');
    let num = BigInt(intPart + fracPart);
    let den = 10n ** BigInt(fracPart.length);
    if (exp >= 0) num *= 10n ** BigInt(exp);
    else den *= 10n ** BigInt(-exp);
    return Rat.fromBigInts(num, den);
  }

  static zero(): Rat {
    return Rat.of(0n);
  }

  private static fromBigInts(num: bigint, den: bigint): Rat {
    if (den === 0n) throw new Error('分母为零');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num < 0n ? -num : num, den);
    return new Rat(num / g, den / g);
  }

  add(other: Rat): Rat {
    return Rat.fromBigInts(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other: Rat): Rat {
    return Rat.fromBigInts(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other: Rat): Rat {
    return Rat.fromBigInts(this.num * other.num, this.den * other.den);
  }

  div(other: Rat): Rat {
    if (other.num === 0n) throw new Error('除以零');
    return Rat.fromBigInts(this.num * other.den, this.den * other.num);
  }

  cmp(other: Rat): number {
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  floor(): bigint {
    const q = this.num / this.den;
    return this.num % this.den !== 0n && this.num < 0n ? q - 1n : q;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  static min(a: Rat, b: Rat): Rat {
    return a.cmp(b) <= 0 ? a : b;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

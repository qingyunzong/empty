/** Exact rational number with bigint numerator/denominator, always normalized (d > 0, gcd = 1). */
export class Rat {
  private constructor(readonly n: bigint, readonly d: bigint) {}

  static of(n: bigint | number, d: bigint | number = 1n): Rat {
    let num = BigInt(n);
    let den = BigInt(d);
    if (den === 0n) throw new Error('Rat: zero denominator');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den);
    return new Rat(num / g, den / g);
  }

  static readonly zero = Rat.of(0n);
  static readonly one = Rat.of(1n);

  isZero(): boolean { return this.n === 0n; }
  sign(): number { return this.n > 0n ? 1 : this.n < 0n ? -1 : 0; }

  add(o: Rat): Rat { return Rat.of(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Rat): Rat { return Rat.of(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Rat): Rat { return Rat.of(this.n * o.n, this.d * o.d); }
  div(o: Rat): Rat {
    if (o.n === 0n) throw new Error('Rat: division by zero');
    return Rat.of(this.n * o.d, this.d * o.n);
  }
  neg(): Rat { return Rat.of(-this.n, this.d); }

  cmp(o: Rat): number {
    const lhs = this.n * o.d;
    const rhs = o.n * this.d;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }
  eq(o: Rat): boolean { return this.n === o.n && this.d === o.d; }
  lt(o: Rat): boolean { return this.cmp(o) < 0; }
  le(o: Rat): boolean { return this.cmp(o) <= 0; }
  gt(o: Rat): boolean { return this.cmp(o) > 0; }
  ge(o: Rat): boolean { return this.cmp(o) >= 0; }

  /** Mathematical floor (rounds toward -infinity). */
  floor(): bigint {
    const q = this.n / this.d;
    return this.n % this.d !== 0n && this.n < 0n ? q - 1n : q;
  }
  /** Mathematical ceil (rounds toward +infinity). */
  ceil(): bigint { return -this.neg().floor(); }
  /** floor(this / m); m must be non-zero. */
  divFloor(m: Rat): bigint { return this.div(m).floor(); }

  toNumber(): number { return Number(this.n) / Number(this.d); }
  toString(): string { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}

/**
 * Exact rational arithmetic on BigInt, used by the independent verifier to
 * recompute compositing results without sharing any code path with the
 * integer pipeline. Every value is kept as a reduced fraction n/d, d > 0.
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

export class Frac {
  private constructor(
    readonly n: bigint,
    readonly d: bigint,
  ) {}

  static of(n: bigint | number, d: bigint | number = 1n): Frac {
    let num = BigInt(n);
    let den = BigInt(d);
    if (den === 0n) throw new RangeError("fraction with zero denominator");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    return new Frac(num / g, den / g);
  }

  static zero(): Frac {
    return Frac.of(0n);
  }

  add(o: Frac): Frac {
    return Frac.of(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o: Frac): Frac {
    return Frac.of(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o: Frac): Frac {
    return Frac.of(this.n * o.n, this.d * o.d);
  }

  abs(): Frac {
    return this.n < 0n ? Frac.of(-this.n, this.d) : this;
  }

  /** Compare against another fraction: -1, 0 or 1. */
  cmp(o: Frac): number {
    const lhs = this.n * o.d;
    const rhs = o.n * this.d;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }
}

/**
 * Round `f * grid` to the nearest integer (ties to even) and return it as a
 * BigInt. Implemented independently of the number-based pipeline; sign
 * symmetric.
 */
export function roundToGridHalfEven(f: Frac, grid: bigint): bigint {
  if (grid <= 0n) throw new RangeError("grid must be positive");
  let num = f.n * grid;
  const den = f.d;
  let neg = false;
  if (num < 0n) {
    num = -num;
    neg = true;
  }
  const rem = num % den;
  let quot = (num - rem) / den;
  const twice = 2n * rem;
  if (twice > den || (twice === den && quot % 2n === 1n)) {
    quot += 1n;
  }
  return neg ? -quot : quot;
}

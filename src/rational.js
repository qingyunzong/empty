// Exact rational arithmetic on BigInt. Amounts are always fractions num/den.

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

export class Frac {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new Error('zero denominator');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static zero() { return new Frac(0n); }

  // Accepts "n", "n/d", "-n/d", "12.34" (exact decimal), or an integer number.
  static parse(v) {
    if (typeof v === 'number' && Number.isInteger(v)) return new Frac(BigInt(v));
    if (typeof v !== 'string') throw new Error(`not a fraction: ${JSON.stringify(v)}`);
    const t = v.trim();
    let m;
    if ((m = /^([+-]?\d+)\/(\d+)$/.exec(t))) {
      const d = BigInt(m[2]);
      if (d === 0n) throw new Error(`zero denominator: ${t}`);
      return new Frac(BigInt(m[1]), d);
    }
    if ((m = /^([+-]?\d+)$/.exec(t))) return new Frac(BigInt(m[1]));
    if ((m = /^([+-]?)(\d*)\.(\d+)$/.exec(t))) {
      const den = 10n ** BigInt(m[3].length);
      let num = BigInt(m[2] || '0') * den + BigInt(m[3]);
      if (m[1] === '-') num = -num;
      return new Frac(num, den);
    }
    throw new Error(`not a fraction: ${t}`);
  }

  add(o) { return new Frac(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { return new Frac(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { return new Frac(this.num * o.num, this.den * o.den); }
  neg() { return new Frac(-this.num, this.den); }
  cmp(o) {
    const l = this.num * o.den, r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  sign() { return this.num < 0n ? -1 : this.num > 0n ? 1 : 0; }
  isZero() { return this.num === 0n; }
  toString() { return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`; }
}

// Round to nearest multiple of 1/100, ties to even (banker's rounding).
export function roundHalfEvenCents(f) {
  const n = f.num * 100n, d = f.den;
  let q = n / d;          // truncates toward zero
  let r = n % d;
  if (r < 0n) r = -r;
  const twice = r * 2n;
  if (twice > d || (twice === d && q % 2n !== 0n)) q += n < 0n ? -1n : 1n;
  return new Frac(q, 100n);
}

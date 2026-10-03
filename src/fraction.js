const abs = (a) => (a < 0n ? -a : a);

function gcd(a, b) {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

// Exact rational number backed by BigInt, always normalized (den > 0, coprime).
export class Fraction {
  constructor(n, d = 1n) {
    n = BigInt(n);
    d = BigInt(d);
    if (d === 0n) throw new Error('fraction with zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
    Object.freeze(this);
  }

  static of(v) {
    if (v instanceof Fraction) return v;
    if (typeof v === 'bigint') return new Fraction(v);
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error(`cannot convert non-integer number ${v} to Fraction`);
      return new Fraction(BigInt(v));
    }
    if (typeof v === 'string') return Fraction.parse(v);
    throw new Error(`cannot convert ${typeof v} to Fraction`);
  }

  static parse(s) {
    s = String(s).trim();
    const rat = /^(-?\d+)\/(\d+)$/.exec(s);
    if (rat) return new Fraction(BigInt(rat[1]), BigInt(rat[2]));
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error(`invalid number: ${s}`);
    const [, sign, int, frac] = m;
    let n = BigInt(int);
    let d = 1n;
    if (frac) {
      d = 10n ** BigInt(frac.length);
      n = n * d + BigInt(frac);
    }
    if (sign) n = -n;
    return new Fraction(n, d);
  }

  add(o) {
    o = Fraction.of(o);
    return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o) {
    o = Fraction.of(o);
    return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o) {
    o = Fraction.of(o);
    return new Fraction(this.n * o.n, this.d * o.d);
  }

  div(o) {
    o = Fraction.of(o);
    return new Fraction(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Fraction(-this.n, this.d);
  }

  cmp(o) {
    o = Fraction.of(o);
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  eq(o) {
    return this.cmp(o) === 0;
  }

  isZero() {
    return this.n === 0n;
  }

  sign() {
    return this.n < 0n ? -1 : this.n > 0n ? 1 : 0;
  }

  isInteger() {
    return this.d === 1n;
  }

  floor() {
    const q = this.n / this.d;
    const f = this.n >= 0n || this.n % this.d === 0n ? q : q - 1n;
    return new Fraction(f);
  }

  frac() {
    return this.sub(this.floor());
  }

  toString() {
    if (this.d === 1n) return this.n.toString();
    let d = this.d;
    let a = 0;
    let b = 0;
    while (d % 2n === 0n) {
      d /= 2n;
      a++;
    }
    while (d % 5n === 0n) {
      d /= 5n;
      b++;
    }
    if (d === 1n) {
      const digits = Math.max(a, b);
      const scale = 10n ** BigInt(digits);
      const scaled = this.n * (scale / this.d);
      const neg = scaled < 0n;
      const s = (neg ? -scaled : scaled).toString().padStart(digits + 1, '0');
      const ip = s.slice(0, s.length - digits);
      const fp = s.slice(s.length - digits);
      return (neg ? '-' : '') + ip + (digits > 0 ? '.' + fp : '');
    }
    return `${this.n}/${this.d}`;
  }
}

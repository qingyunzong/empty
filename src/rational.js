'use strict';

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

class Frac {
  constructor(n, d = 1n) {
    n = BigInt(n);
    d = BigInt(d);
    if (d === 0n) throw new Error('zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }

  static of(x) {
    if (x instanceof Frac) return x;
    return new Frac(BigInt(x));
  }

  add(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.n, this.d * o.d);
  }

  div(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Frac(-this.n, this.d);
  }

  abs() {
    return this.n < 0n ? new Frac(-this.n, this.d) : this;
  }

  cmp(o) {
    o = Frac.of(o);
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  isZero() {
    return this.n === 0n;
  }

  toString() {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }
}

// Round to whole cents, half away from zero. Returns a Frac with d = 100.
function roundToCents(f) {
  const scaled = f.n * 100n;
  let q = scaled / f.d;
  const r = scaled % f.d;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= f.d) q += scaled < 0n ? -1n : 1n;
  return new Frac(q, 100n);
}

module.exports = { Frac, roundToCents };

const bigAbs = (x) => (x < 0n ? -x : x);

function gcd(a, b) {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export class Frac {
  #n;
  #d;

  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new RangeError('fraction denominator must not be zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.#n = num / g;
    this.#d = den / g;
    Object.freeze(this);
  }

  get num() {
    return this.#n;
  }

  get den() {
    return this.#d;
  }

  static zero() {
    return new Frac(0n);
  }

  static one() {
    return new Frac(1n);
  }

  static parse(text) {
    const m = /^(-?\d+)(?:\/(\d+))?$/.exec(String(text).trim());
    if (!m) throw new RangeError(`not a rational literal: ${text}`);
    return new Frac(BigInt(m[1]), m[2] === undefined ? 1n : BigInt(m[2]));
  }

  add(o) {
    return new Frac(this.#n * o.#d + o.#n * this.#d, this.#d * o.#d);
  }

  sub(o) {
    return new Frac(this.#n * o.#d - o.#n * this.#d, this.#d * o.#d);
  }

  mul(o) {
    return new Frac(this.#n * o.#n, this.#d * o.#d);
  }

  div(o) {
    if (o.#n === 0n) throw new RangeError('division by zero fraction');
    return new Frac(this.#n * o.#d, this.#d * o.#n);
  }

  neg() {
    return new Frac(-this.#n, this.#d);
  }

  abs() {
    return new Frac(bigAbs(this.#n), this.#d);
  }

  sign() {
    return this.#n > 0n ? 1 : this.#n < 0n ? -1 : 0;
  }

  isZero() {
    return this.#n === 0n;
  }

  cmp(o) {
    const l = this.#n * o.#d;
    const r = o.#n * this.#d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  eq(o) {
    return this.#n === o.#n && this.#d === o.#d;
  }

  toString() {
    return this.#d === 1n ? this.#n.toString() : `${this.#n}/${this.#d}`;
  }

  toJSON() {
    return this.toString();
  }
}

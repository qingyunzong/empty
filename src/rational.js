function igcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function floorDiv(a, b) {
  if (b === 0n) throw new RangeError('division by zero');
  let q = a / b;
  if (a % b !== 0n && (a < 0n) !== (b < 0n)) q -= 1n;
  return q;
}

export class Rat {
  constructor(num, den = 1n) {
    if (den === 0n) throw new RangeError('rational with zero denominator');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = num === 0n ? den : igcd(num, den);
    this.n = num / g;
    this.d = den / g;
    Object.freeze(this);
  }

  static int(value) {
    return new Rat(BigInt(value));
  }

  static of(value) {
    if (value instanceof Rat) return value;
    if (typeof value === 'bigint') return new Rat(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError(`not a finite number: ${value}`);
      return parseDecimal(String(value));
    }
    if (typeof value === 'string') {
      const s = value.trim();
      if (/^[+-]?\d+$/.test(s)) return new Rat(BigInt(s));
      const frac = /^([+-]?\d+)\/([+-]?\d+)$/.exec(s);
      if (frac) return new Rat(BigInt(frac[1]), BigInt(frac[2]));
      return parseDecimal(s);
    }
    throw new TypeError(`cannot interpret as rational: ${String(value)}`);
  }

  add(o) { return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Rat(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Rat(this.n * o.n, this.d * o.d); }
  div(o) { return new Rat(this.n * o.d, this.d * o.n); }
  neg() { return new Rat(-this.n, this.d); }
  abs() { return this.n < 0n ? new Rat(-this.n, this.d) : this; }
  sign() { return this.n > 0n ? 1 : this.n < 0n ? -1 : 0; }
  isZero() { return this.n === 0n; }
  cmp(o) {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o) { return this.n === o.n && this.d === o.d; }
  toString() { return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`; }
  toJSON() { return this.toString(); }
}

function parseDecimal(s) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) throw new TypeError(`invalid rational: ${s}`);
  const intPart = m[2] === '' ? '0' : m[2];
  const fracPart = m[3] ?? '';
  const digits = intPart + fracPart;
  if (!/^\d+$/.test(digits)) throw new TypeError(`invalid rational: ${s}`);
  let num = BigInt(digits);
  let den = 10n ** BigInt(fracPart.length);
  if (m[1] === '-') num = -num;
  if (m[4]) {
    const exp = BigInt(m[4]);
    if (exp >= 0n) num *= 10n ** exp;
    else den *= 10n ** (-exp);
  }
  return new Rat(num, den);
}

export const RAT_ZERO = new Rat(0n);
export const RAT_ONE = new Rat(1n);
export const RAT_TWO = new Rat(2n);

// Exact rational numbers backed by BigInt, always kept in lowest terms
// with a positive denominator.

export class RationalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RationalError';
    this.code = 'E_RATIONAL';
  }
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

const INT_RE = /^[+-]?\d+$/;
const FRAC_RE = /^([+-]?\d+)\/([+-]?\d+)$/;
const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export class Rational {
  #n;
  #d;

  constructor(num, den = 1n) {
    if (typeof num !== 'bigint' || typeof den !== 'bigint') {
      throw new RationalError('Rational components must be BigInt');
    }
    if (den === 0n) throw new RationalError('Denominator must not be zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.#n = num / g;
    this.#d = den / g;
    Object.freeze(this);
  }

  get num() { return this.#n; }
  get den() { return this.#d; }

  static zero() { return new Rational(0n); }

  static fromBigInt(v) { return new Rational(v); }

  // Parses a JSON value into an exact Rational.
  // Accepts: finite numbers (integers and decimals), integer strings,
  // decimal strings ("1.25", "-0.5", "1e-3") and fraction strings ("3/4").
  // Anything else raises RationalError (code E_RATIONAL).
  static parse(value) {
    if (value instanceof Rational) return value;
    if (typeof value === 'bigint') return new Rational(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new RationalError(`Not a finite number: ${value}`);
      }
      return Rational.#parseDecimalString(String(value));
    }
    if (typeof value === 'string') {
      const s = value.trim();
      if (INT_RE.test(s)) return new Rational(BigInt(s));
      const frac = FRAC_RE.exec(s);
      if (frac) return new Rational(BigInt(frac[1]), BigInt(frac[2]));
      if (DEC_RE.test(s) && /\d/.test(s)) return Rational.#parseDecimalString(s);
      throw new RationalError(`Invalid rational: ${JSON.stringify(value)}`);
    }
    throw new RationalError(`Invalid rational value: ${JSON.stringify(value)}`);
  }

  static #parseDecimalString(s) {
    const m = DEC_RE.exec(s);
    if (!m || !/\d/.test(s)) throw new RationalError(`Invalid rational: ${s}`);
    const sign = m[1] === '-' ? -1n : 1n;
    const intPart = m[2] || '0';
    const fracPart = m[3] || '';
    const exp = m[4] ? BigInt(m[4]) : 0n;
    let num = BigInt(intPart + fracPart);
    let den = 10n ** BigInt(fracPart.length);
    if (exp >= 0n) num *= 10n ** exp;
    else den *= 10n ** (-exp);
    return new Rational(sign * num, den);
  }

  add(o) { return new Rational(this.#n * o.#d + o.#n * this.#d, this.#d * o.#d); }
  sub(o) { return new Rational(this.#n * o.#d - o.#n * this.#d, this.#d * o.#d); }
  mul(o) { return new Rational(this.#n * o.#n, this.#d * o.#d); }
  neg() { return new Rational(-this.#n, this.#d); }

  cmp(o) {
    const l = this.#n * o.#d;
    const r = o.#n * this.#d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  lt(o) { return this.cmp(o) < 0; }
  lte(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  gte(o) { return this.cmp(o) >= 0; }
  isNegative() { return this.#n < 0n; }

  toString() {
    return this.#d === 1n ? this.#n.toString() : `${this.#n}/${this.#d}`;
  }

  toJSON() { return this.toString(); }
}

export function sumRationals(list) {
  let acc = Rational.zero();
  for (const r of list) acc = acc.add(r);
  return acc;
}

// Exact rational arithmetic on BigInt. All fractions are stored normalized:
// denominator > 0, gcd(|num|, den) = 1, zero is 0/1.

export class IllegalCoordinateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IllegalCoordinateError';
  }
}

function abs(value) {
  return value < 0n ? -value : value;
}

function gcd(a, b) {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

const INTEGER_RE = /^[+-]?\d+$/;
const FRACTION_RE = /^([+-]?\d+)\/([+-]?\d+)$/;
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function parseDecimalString(text) {
  const m = DECIMAL_RE.exec(text);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new IllegalCoordinateError(`invalid rational literal: ${JSON.stringify(text)}`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] || '0';
  const fracPart = m[3] || '';
  const exponent = m[4] === undefined ? 0n : BigInt(m[4]);
  let num = BigInt(intPart + fracPart);
  let den = 10n ** BigInt(fracPart.length);
  if (exponent >= 0n) {
    num *= 10n ** exponent;
  } else {
    den *= 10n ** (-exponent);
  }
  return new Fraction(sign * num, den);
}

export class Fraction {
  #num;
  #den;

  constructor(num, den = 1n) {
    if (typeof num !== 'bigint' || typeof den !== 'bigint') {
      throw new TypeError('Fraction requires BigInt numerator/denominator');
    }
    if (den === 0n) {
      throw new IllegalCoordinateError('denominator must not be zero');
    }
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    if (num === 0n) {
      den = 1n;
    } else {
      const g = gcd(num, den);
      num /= g;
      den /= g;
    }
    this.#num = num;
    this.#den = den;
  }

  static get ZERO() {
    return new Fraction(0n);
  }

  static get ONE() {
    return new Fraction(1n);
  }

  // Accepts: Fraction, BigInt, integer/decimal Number, "p/q" / decimal string,
  // or { num, den } (each parseable as an integer).
  static parse(value) {
    if (value instanceof Fraction) return value;
    if (typeof value === 'bigint') return new Fraction(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new IllegalCoordinateError(`non-finite coordinate: ${value}`);
      }
      return parseDecimalString(String(value));
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (INTEGER_RE.test(text)) return new Fraction(BigInt(text));
      const frac = FRACTION_RE.exec(text);
      if (frac) return new Fraction(BigInt(frac[1]), BigInt(frac[2]));
      return parseDecimalString(text);
    }
    if (value && typeof value === 'object' && 'num' in value && 'den' in value) {
      const num = Fraction.parseIntLike(value.num, 'num');
      const den = Fraction.parseIntLike(value.den, 'den');
      return new Fraction(num, den);
    }
    throw new IllegalCoordinateError(`unsupported coordinate value: ${JSON.stringify(value)}`);
  }

  static parseIntLike(value, field) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && INTEGER_RE.test(value.trim())) return BigInt(value.trim());
    throw new IllegalCoordinateError(`invalid integer for ${field}: ${JSON.stringify(value)}`);
  }

  get num() { return this.#num; }
  get den() { return this.#den; }

  add(other) {
    other = Fraction.parse(other);
    return new Fraction(this.#num * other.#den + other.#num * this.#den, this.#den * other.#den);
  }

  sub(other) {
    other = Fraction.parse(other);
    return new Fraction(this.#num * other.#den - other.#num * this.#den, this.#den * other.#den);
  }

  mul(other) {
    other = Fraction.parse(other);
    return new Fraction(this.#num * other.#num, this.#den * other.#den);
  }

  div(other) {
    other = Fraction.parse(other);
    if (other.#num === 0n) throw new IllegalCoordinateError('division by zero');
    return new Fraction(this.#num * other.#den, this.#den * other.#num);
  }

  neg() {
    return new Fraction(-this.#num, this.#den);
  }

  cmp(other) {
    other = Fraction.parse(other);
    const lhs = this.#num * other.#den;
    const rhs = other.#num * this.#den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  equals(other) {
    return this.cmp(other) === 0;
  }

  isZero() {
    return this.#num === 0n;
  }

  sign() {
    return this.#num < 0n ? -1 : this.#num > 0n ? 1 : 0;
  }

  toString() {
    return `${this.#num}/${this.#den}`;
  }

  toJSON() {
    return this.toString();
  }
}

// Exact rational arithmetic on BigInt. All values are normalized:
// denominator > 0, gcd(|num|, den) = 1, zero is 0/1.

export class RationalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RationalError';
    this.code = 'E_RATIONAL';
  }
}

function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export class Frac {
  #num;
  #den;

  constructor(num, den = 1n) {
    if (typeof num !== 'bigint' || typeof den !== 'bigint') {
      throw new RationalError('fraction parts must be BigInt');
    }
    if (den === 0n) throw new RationalError('denominator is zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.#num = num / g;
    this.#den = den / g;
    Object.freeze(this);
  }

  get num() { return this.#num; }
  get den() { return this.#den; }

  static zero() { return new Frac(0n); }
  static one() { return new Frac(1n); }

  isZero() { return this.#num === 0n; }
  sign() { return this.#num > 0n ? 1 : this.#num < 0n ? -1 : 0; }

  add(o) { return new Frac(this.#num * o.#den + o.#num * this.#den, this.#den * o.#den); }
  sub(o) { return new Frac(this.#num * o.#den - o.#num * this.#den, this.#den * o.#den); }
  mul(o) { return new Frac(this.#num * o.#num, this.#den * o.#den); }
  div(o) {
    if (o.#num === 0n) throw new RationalError('division by zero');
    return new Frac(this.#num * o.#den, this.#den * o.#num);
  }
  neg() { return new Frac(-this.#num, this.#den); }

  cmp(o) {
    const lhs = this.#num * o.#den;
    const rhs = o.#num * this.#den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }
  eq(o) { return this.cmp(o) === 0; }

  toString() {
    return this.#den === 1n ? this.#num.toString() : `${this.#num}/${this.#den}`;
  }
  toJSON() { return this.toString(); }
}

const FRACTION_RE = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/;
const INTEGER_RE = /^[+-]?\d+$/;
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function parseStringRational(text) {
  const s = text.trim();
  const fracMatch = FRACTION_RE.exec(s);
  if (fracMatch) {
    return new Frac(BigInt(fracMatch[1]), BigInt(fracMatch[2]));
  }
  if (INTEGER_RE.test(s)) {
    return new Frac(BigInt(s));
  }
  const decMatch = DECIMAL_RE.exec(s);
  if (decMatch && (decMatch[2] !== '' || decMatch[3] !== undefined)) {
    const sign = decMatch[1] === '-' ? -1n : 1n;
    const intPart = decMatch[2] === '' ? 0n : BigInt(decMatch[2]);
    const fracDigits = decMatch[3] ?? '';
    const scale = 10n ** BigInt(fracDigits.length);
    let num = sign * (intPart * scale + BigInt(fracDigits === '' ? '0' : fracDigits));
    let den = scale;
    const exp = decMatch[4] === undefined ? 0n : BigInt(decMatch[4]);
    if (exp >= 0n) num *= 10n ** exp;
    else den *= 10n ** (-exp);
    return new Frac(num, den);
  }
  throw new RationalError(`not a rational: ${JSON.stringify(text)}`);
}

function toBigIntExact(value, what) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && INTEGER_RE.test(value.trim())) return BigInt(value.trim());
  throw new RationalError(`${what} must be an integer`);
}

// Accepts: Frac, bigint, integer number, finite decimal number,
// string "p", "p/q", decimal, or { num, den } with integer parts.
export function parseRational(value) {
  if (value instanceof Frac) return value;
  if (typeof value === 'bigint') return new Frac(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RationalError('not a finite number');
    if (Number.isInteger(value)) return new Frac(BigInt(value));
    return parseStringRational(String(value));
  }
  if (typeof value === 'string') return parseStringRational(value);
  if (value !== null && typeof value === 'object' && 'num' in value) {
    const num = toBigIntExact(value.num, 'num');
    const den = value.den === undefined ? 1n : toBigIntExact(value.den, 'den');
    return new Frac(num, den);
  }
  throw new RationalError('not a rational value');
}

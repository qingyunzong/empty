import { E, QError } from './errors.js';

const absBig = (a) => (a < 0n ? -a : a);

function gcd(a, b) {
  a = absBig(a);
  b = absBig(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

const INT_RE = /^[+-]?\d+$/;
const DEC_RE = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function bigFromIntLike(value, what) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new QError(E.RATIONAL, `${what} must be an integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && INT_RE.test(value.trim())) return BigInt(value.trim());
  throw new QError(E.RATIONAL, `${what} must be an integer, got ${JSON.stringify(value)}`);
}

function parseDecimal(str) {
  const m = DEC_RE.exec(str.trim());
  if (!m) throw new QError(E.RATIONAL, `invalid rational string: ${JSON.stringify(str)}`);
  const [, sign, intPart, fracPart = '', expPart] = m;
  let num = BigInt(intPart + fracPart);
  let den = 10n ** BigInt(fracPart.length);
  if (expPart !== undefined) {
    const e = BigInt(expPart);
    if (e >= 0n) num *= 10n ** e;
    else den *= 10n ** -e;
  }
  if (sign === '-') num = -num;
  return new Rat(num, den);
}

/** Exact rational number backed by BigInt, always normalized (den > 0, gcd = 1). Immutable. */
export class Rat {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new QError(E.RATIONAL, 'rational denominator is zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den) || 1n;
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  isZero() { return this.num === 0n; }
  sign() { return this.num > 0n ? 1 : this.num < 0n ? -1 : 0; }
  neg() { return new Rat(-this.num, this.den); }
  abs() { return this.num < 0n ? new Rat(-this.num, this.den) : this; }
  add(o) { return new Rat(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { return new Rat(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { return new Rat(this.num * o.num, this.den * o.den); }
  div(o) {
    if (o.isZero()) throw new QError(E.RATIONAL, 'division by zero rational');
    return new Rat(this.num * o.den, this.den * o.num);
  }
  cmp(o) {
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  lte(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  gte(o) { return this.cmp(o) >= 0; }
  toString() { return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`; }
  toJSON() { return this.toString(); }
}

export const ZERO = new Rat(0n);
export const ONE = new Rat(1n);

/**
 * Parse a rational from: Rat, bigint, integer/decimal number, decimal string
 * ("-12.5", "1e-3"), fraction string ("-3/4"), or { num, den }.
 * Throws QError(E_RATIONAL) on bad input or zero denominator.
 */
export function rat(value) {
  if (value instanceof Rat) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new QError(E.RATIONAL, `non-finite number: ${value}`);
    return parseDecimal(String(value));
  }
  if (typeof value === 'bigint') return new Rat(value);
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.includes('/')) {
      const parts = s.split('/');
      if (parts.length !== 2) throw new QError(E.RATIONAL, `invalid fraction: ${JSON.stringify(value)}`);
      return new Rat(bigFromIntLike(parts[0], 'numerator'), bigFromIntLike(parts[1], 'denominator'));
    }
    return parseDecimal(s);
  }
  if (value && typeof value === 'object' && 'num' in value) {
    const den = 'den' in value ? value.den : 1n;
    return new Rat(bigFromIntLike(value.num, 'numerator'), bigFromIntLike(den, 'denominator'));
  }
  throw new QError(E.RATIONAL, `cannot parse rational from ${JSON.stringify(value)}`);
}

/** Round r to `decimals` decimal places, half away from zero. Returns scaled BigInt (value * 10^decimals). */
export function roundToScaledInt(r, decimals) {
  const scale = 10n ** BigInt(decimals);
  const scaled = r.num * scale;
  const den = r.den;
  let q = scaled / den;
  const rem = scaled % den;
  if (absBig(rem) * 2n >= den) q += scaled >= 0n ? 1n : -1n;
  return q;
}

/** Format a scaled BigInt (from roundToScaledInt) as a decimal string with exactly `decimals` places. */
export function formatScaledInt(q, decimals) {
  const neg = q < 0n;
  const digits = absBig(q).toString();
  if (decimals === 0) return (neg ? '-' : '') + digits;
  const padded = digits.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  return `${neg ? '-' : ''}${intPart}.${fracPart}`;
}

/** Exact upper bound |rounded - exact| <= 1 / (2 * 10^decimals). */
export function roundingErrorBound(decimals) {
  return new Rat(1n, 2n * 10n ** BigInt(decimals));
}

export function assertDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new QError(E.VALIDATION, `decimals must be an integer in [0, 30], got ${JSON.stringify(decimals)}`);
  }
}

import { rationalError } from './errors.js';

function absBig(value) {
  return value < 0n ? -value : value;
}

function gcdBig(a, b) {
  a = absBig(a);
  b = absBig(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

// Exact rational number backed by BigInt, always normalized (den > 0, reduced).
export class Rat {
  constructor(num, den = 1n) {
    if (typeof num !== 'bigint' || typeof den !== 'bigint') {
      throw rationalError('Rat components must be BigInt');
    }
    if (den === 0n) {
      throw rationalError('E_RATIONAL: denominator is zero');
    }
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcdBig(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static zero() {
    return new Rat(0n, 1n);
  }

  static one() {
    return new Rat(1n, 1n);
  }

  static fromBigInt(value) {
    return new Rat(value, 1n);
  }

  // Parses "a", "-a", "a/b", "-a/b" (optional whitespace). No floats allowed.
  static parse(text) {
    if (text instanceof Rat) return text;
    if (typeof text === 'bigint') return new Rat(text, 1n);
    if (typeof text === 'number') {
      throw rationalError(`E_RATIONAL: numeric literal ${text} is not exact; use "p/q" string form`);
    }
    if (typeof text !== 'string') {
      throw rationalError(`E_RATIONAL: cannot parse rational from ${String(text)}`);
    }
    const trimmed = text.trim();
    const match = /^([+-]?\d+)(?:\s*\/\s*([+-]?\d+))?$/.exec(trimmed);
    if (!match) {
      throw rationalError(`E_RATIONAL: malformed rational "${text}"`);
    }
    const num = BigInt(match[1]);
    const den = match[2] === undefined ? 1n : BigInt(match[2]);
    if (den === 0n) {
      throw rationalError(`E_RATIONAL: denominator is zero in "${text}"`);
    }
    return new Rat(num, den);
  }

  add(other) {
    return new Rat(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other) {
    return new Rat(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other) {
    return new Rat(this.num * other.num, this.den * other.den);
  }

  div(other) {
    if (other.num === 0n) {
      throw rationalError('E_RATIONAL: division by zero rational');
    }
    return new Rat(this.num * other.den, this.den * other.num);
  }

  neg() {
    return new Rat(-this.num, this.den);
  }

  abs() {
    return this.num < 0n ? this.neg() : this;
  }

  sign() {
    return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
  }

  cmp(other) {
    const left = this.num * other.den;
    const right = other.num * this.den;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other) {
    return this.num === other.num && this.den === other.den;
  }

  isInteger() {
    return this.den === 1n;
  }

  toString() {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  toJSON() {
    return this.toString();
  }
}

// floor(a / b) for BigInt with b > 0 (BigInt "/" truncates toward zero).
export function floorDiv(a, b) {
  if (b <= 0n) throw rationalError('E_RATIONAL: floorDiv requires positive divisor');
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

// Round half up (ties toward +Infinity), exact.
export function roundHalfUp(rat) {
  return floorDiv(2n * rat.num + rat.den, 2n * rat.den);
}

export function maxRat(a, b) {
  return a.cmp(b) >= 0 ? a : b;
}

export function minRat(a, b) {
  return a.cmp(b) <= 0 ? a : b;
}

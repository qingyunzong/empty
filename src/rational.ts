export type RationalInput = Rational | string | bigint | number;

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  a = absBigInt(a);
  b = absBigInt(b);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new RangeError("invalid decimal exponent");
  }
  return 10n ** BigInt(exponent);
}

/**
 * An arbitrary-precision rational number. The denominator is always positive
 * and the fraction is kept in lowest terms.
 */
export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  constructor(numerator: bigint, denominator: bigint = 1n) {
    if (denominator === 0n) {
      throw new RangeError("rational denominator must not be zero");
    }
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(numerator, denominator);
    this.numerator = (numerator / divisor) * sign;
    this.denominator = absBigInt(denominator) / divisor;
  }

  static readonly ZERO = new Rational(0n, 1n);
  static readonly ONE = new Rational(1n, 1n);

  static from(value: RationalInput, label = "value"): Rational {
    if (value instanceof Rational) {
      return value;
    }
    if (typeof value === "bigint") {
      return new Rational(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number`);
      }
      return parseText(String(value), label);
    }
    if (typeof value === "string") {
      return parseText(value.trim(), label);
    }
    throw new TypeError(`${label} must be a rational, string, bigint, or number`);
  }

  add(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    return new Rational(
      this.numerator * rhs.denominator + rhs.numerator * this.denominator,
      this.denominator * rhs.denominator,
    );
  }

  sub(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    return new Rational(
      this.numerator * rhs.denominator - rhs.numerator * this.denominator,
      this.denominator * rhs.denominator,
    );
  }

  mul(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    return new Rational(
      this.numerator * rhs.numerator,
      this.denominator * rhs.denominator,
    );
  }

  div(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    if (rhs.numerator === 0n) {
      throw new RangeError("division by zero");
    }
    return new Rational(
      this.numerator * rhs.denominator,
      this.denominator * rhs.numerator,
    );
  }

  neg(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }

  abs(): Rational {
    return this.numerator < 0n ? this.neg() : this;
  }

  compare(other: RationalInput): -1 | 0 | 1 {
    const rhs = Rational.from(other);
    const left = this.numerator * rhs.denominator;
    const right = rhs.numerator * this.denominator;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other: RationalInput): boolean {
    return this.compare(other) === 0;
  }

  lessThan(other: RationalInput): boolean {
    return this.compare(other) < 0;
  }

  lessThanOrEqual(other: RationalInput): boolean {
    return this.compare(other) <= 0;
  }

  greaterThan(other: RationalInput): boolean {
    return this.compare(other) > 0;
  }

  greaterThanOrEqual(other: RationalInput): boolean {
    return this.compare(other) >= 0;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  isInteger(): boolean {
    return this.denominator === 1n;
  }

  sign(): -1 | 0 | 1 {
    return this.numerator < 0n ? -1 : this.numerator > 0n ? 1 : 0;
  }

  floor(): bigint {
    const quotient = this.numerator / this.denominator;
    return this.numerator < 0n && this.numerator % this.denominator !== 0n
      ? quotient - 1n
      : quotient;
  }

  ceil(): bigint {
    const quotient = this.numerator / this.denominator;
    return this.numerator > 0n && this.numerator % this.denominator !== 0n
      ? quotient + 1n
      : quotient;
  }

  toNumber(): number {
    return Number(this.numerator) / Number(this.denominator);
  }

  toString(): string {
    return this.denominator === 1n
      ? `${this.numerator}`
      : `${this.numerator}/${this.denominator}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

function parseText(text: string, label: string): Rational {
  if (text.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }

  const fraction = /^([+-]?)(\d+)\/(\d+)$/.exec(text);
  if (fraction) {
    const numerator = BigInt(`${fraction[1]}${fraction[2]}`);
    const denominator = BigInt(fraction[3]);
    if (denominator === 0n) {
      throw new RangeError(`${label} must not have a zero denominator`);
    }
    return new Rational(numerator, denominator);
  }

  const decimal =
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(
      text,
    );
  if (!decimal) {
    throw new TypeError(`${label} is not a decimal or rational literal`);
  }

  const sign = decimal[1] === "-" ? -1n : 1n;
  const whole = decimal[2] ?? "0";
  const fractionDigits = decimal[2] === undefined ? decimal[4] : decimal[3] ?? "";
  const exponent = decimal[5] === undefined ? 0 : Number(decimal[5]);
  if (!Number.isSafeInteger(exponent)) {
    throw new RangeError(`${label} has an invalid exponent`);
  }

  let numerator = BigInt(`${whole}${fractionDigits}`);
  let denominator = powerOfTen(fractionDigits.length);
  if (exponent >= 0) {
    numerator *= powerOfTen(exponent);
  } else {
    denominator *= powerOfTen(-exponent);
  }
  return new Rational(sign * numerator, denominator);
}


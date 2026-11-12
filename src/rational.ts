export interface RationalObject {
  numerator: bigint | number | string;
  denominator?: bigint | number | string;
}

export type RationalInput = Rational | RationalObject | number | bigint | string;

const DECIMAL_PATTERN =
  /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const UNSIGNED_DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const INTEGER_PATTERN = /^[+-]?\d+$/;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function decimalToParts(text: string): { numerator: bigint; denominator: bigint } | null {
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction =
    match[2] === undefined ? match[4] ?? "" : match[3] ?? "";
  const exponent =
    match[5] === undefined ? 0 : Number.parseInt(match[5], 10);
  if (!Number.isSafeInteger(exponent)) {
    return null;
  }

  let numerator = sign * BigInt(`${whole}${fraction}`);
  let denominator = pow10(fraction.length);
  if (exponent > 0) {
    numerator *= pow10(exponent);
  } else if (exponent < 0) {
    denominator *= pow10(-exponent);
  }
  return { numerator, denominator };
}

function integerToBigInt(value: bigint | number | string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isFinite(value)) {
      throw new TypeError("Rational numerator/denominator must be integers");
    }
    return BigInt(value);
  }
  if (!INTEGER_PATTERN.test(value.trim())) {
    throw new TypeError(`Invalid integer: ${value}`);
  }
  return BigInt(value.trim());
}

/**
 * Exact rational arithmetic. Denominators are kept positive and the fraction
 * is reduced after every construction.
 */
export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  constructor(numerator: bigint, denominator: bigint = 1n) {
    if (denominator === 0n) {
      throw new TypeError("Rational denominator must not be zero");
    }
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    const divisor = gcd(numerator, denominator);
    if (divisor === 0n) {
      this.numerator = 0n;
      this.denominator = 1n;
      return;
    }
    this.numerator = numerator / divisor;
    this.denominator = denominator / divisor;
  }

  static from(input: RationalInput): Rational {
    if (input instanceof Rational) {
      return input;
    }
    if (typeof input === "bigint") {
      return new Rational(input);
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new TypeError("Rational number must be finite");
      }
      if (Number.isInteger(input)) {
        return new Rational(BigInt(input));
      }
      const parts = decimalToParts(String(input));
      if (!parts) {
        throw new TypeError(`Cannot parse number as a rational: ${input}`);
      }
      return new Rational(parts.numerator, parts.denominator);
    }
    if (typeof input === "string") {
      const text = input.trim();
      const slash = text.indexOf("/");
      if (slash !== -1) {
        const left = decimalToParts(text.slice(0, slash).trim());
        const right = decimalToParts(text.slice(slash + 1).trim());
        if (!left || !right || right.numerator === 0n) {
          throw new TypeError(`Invalid rational string: ${input}`);
        }
        return new Rational(
          left.numerator * right.denominator,
          left.denominator * right.numerator,
        );
      }
      const parts = decimalToParts(text);
      if (!parts) {
        throw new TypeError(`Invalid rational string: ${input}`);
      }
      return new Rational(parts.numerator, parts.denominator);
    }
    if (input && typeof input === "object") {
      const numerator = integerToBigInt(input.numerator);
      const denominator =
        input.denominator === undefined ? 1n : integerToBigInt(input.denominator);
      return new Rational(numerator, denominator);
    }
    throw new TypeError("Unsupported rational input");
  }

  /**
   * Parses the exact decimal syntax used by srcset and sizes: an integer or a
   * decimal with digits on both sides of the point. No sign and no exponent.
   */
  static fromUnsignedDecimal(text: string): Rational | null {
    if (!UNSIGNED_DECIMAL_PATTERN.test(text)) {
      return null;
    }
    const parts = decimalToParts(text);
    return parts === null ? null : new Rational(parts.numerator, parts.denominator);
  }

  add(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    return new Rational(
      this.numerator * rhs.denominator + rhs.numerator * this.denominator,
      this.denominator * rhs.denominator,
    );
  }

  subtract(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    return new Rational(
      this.numerator * rhs.denominator - rhs.numerator * this.denominator,
      this.denominator * rhs.denominator,
    );
  }

  multiply(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    return new Rational(
      this.numerator * rhs.numerator,
      this.denominator * rhs.denominator,
    );
  }

  divide(other: RationalInput): Rational {
    const rhs = Rational.from(other);
    if (rhs.numerator === 0n) {
      throw new TypeError("Division by zero");
    }
    return new Rational(
      this.numerator * rhs.denominator,
      this.denominator * rhs.numerator,
    );
  }

  negate(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }

  compare(other: RationalInput): -1 | 0 | 1 {
    const rhs = Rational.from(other);
    const left = this.numerator * rhs.denominator;
    const right = rhs.numerator * this.denominator;
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }

  equals(other: RationalInput): boolean {
    return this.compare(other) === 0;
  }

  isPositive(): boolean {
    return this.numerator > 0n;
  }

  isNonNegative(): boolean {
    return this.numerator >= 0n;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  isInteger(): boolean {
    return this.denominator === 1n;
  }

  toNumber(): number {
    return Number(this.numerator) / Number(this.denominator);
  }

  toString(): string {
    return this.denominator === 1n
      ? this.numerator.toString()
      : `${this.numerator}/${this.denominator}`;
  }

  toJSON(): { numerator: string; denominator: string } {
    return {
      numerator: this.numerator.toString(),
      denominator: this.denominator.toString(),
    };
  }
}

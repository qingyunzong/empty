/**
 * Exact rational numbers backed by BigInt, always kept in normal form:
 * denominator strictly positive, numerator and denominator coprime.
 * This avoids floating-point error in policy threshold comparisons
 * (e.g. 1/10 + 2/10 vs 3/10).
 */

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/** Construct a normalized rational. Throws on zero denominator. */
export function rational(numerator: bigint, denominator: bigint = 1n): Rational {
  if (denominator === 0n) throw new RangeError("rational: zero denominator");
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

const RATIONAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?(?:\/(\d+))?$/;

/**
 * Parse "2", "-3/4", "0.5", "+1.25" into an exact Rational.
 * Decimal notation is converted exactly ("1.1" -> 11/10, never a float).
 */
export function parseRational(text: string): Rational {
  const m = RATIONAL_RE.exec(text.trim());
  if (!m) throw new SyntaxError(`rational: cannot parse ${JSON.stringify(text)}`);
  const [, sign, intPart, fracPart, denPart] = m;
  const negative = sign === "-";
  if (denPart !== undefined) {
    if (fracPart !== undefined) {
      throw new SyntaxError(`rational: cannot mix decimal and fraction in ${JSON.stringify(text)}`);
    }
    const n = BigInt(intPart) * (negative ? -1n : 1n);
    return rational(n, BigInt(denPart));
  }
  const digits = fracPart ?? "";
  const scale = 10n ** BigInt(digits.length);
  const n = (BigInt(intPart) * scale + BigInt(digits === "" ? 0 : digits)) * (negative ? -1n : 1n);
  return rational(n, scale);
}

export function isRational(value: unknown): value is Rational {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Rational).n === "bigint" &&
    typeof (value as Rational).d === "bigint"
  );
}

/** Total order on rationals: -1, 0, 1. */
export function cmpRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function eqRational(a: Rational, b: Rational): boolean {
  return a.n === b.n && a.d === b.d;
}

export function addRational(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

/** Midpoint of two rationals; used to sample open intervals between thresholds. */
export function midRational(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, 2n * a.d * b.d);
}

export function formatRational(r: Rational): string {
  return r.d === 1n ? r.n.toString() : `${r.n}/${r.d}`;
}

/** Stable key for deduplication in sets/maps. */
export function rationalKey(r: Rational): string {
  return `${r.n}/${r.d}`;
}

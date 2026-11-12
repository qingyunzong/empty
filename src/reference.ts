// Independent reference model using exact signed numerator / positive
// denominator rational arithmetic. It deliberately does not import any
// rounding logic from bid128.ts: it only decodes the public field view and
// then recomputes everything from bigint numerator and denominator pairs.

import {
  MAX_COEFF,
  type Bid128Field,
  type CompareResult,
  type FieldView,
  type RoundingMode,
  type Sign,
} from "./bid128.ts";

export type Rational = {
  sign: Sign;
  numerator: bigint; // non-negative magnitude numerator
  denominator: bigint; // strictly positive, always a power of ten
};

export type ReferenceQuantize =
  | {
      status: "ok";
      sign: Sign;
      coefficient: bigint;
      exponent: number;
      rounded: boolean;
      inexact: boolean;
      sourceNonCanonical: boolean;
    }
  | { status: "notFinite" }
  | { status: "invalidQuantize" };

export function toRational(view: FieldView): Rational | "infinity" | "nan" {
  if (view.kind === "nan") {
    return "nan";
  }
  if (view.kind === "infinity") {
    return "infinity";
  }
  if (view.exponent >= 0) {
    return {
      sign: view.sign,
      numerator: view.coefficient * 10n ** BigInt(view.exponent),
      denominator: 1n,
    };
  }
  return {
    sign: view.sign,
    numerator: view.coefficient,
    denominator: 10n ** BigInt(-view.exponent),
  };
}

/**
 * Independent reference quantization. It re-derives the integer quotient and
 * remainder directly from the decoded (sign, C, e) triple using the task's
 * closed integer rule, keeping its own local variables so it cannot share an
 * implementation path with the package under test. The rational model in
 * toRational is reserved for comparison cross-checking.
 */
export function referenceQuantize(
  field: Bid128Field,
  q: number,
  mode: RoundingMode,
): ReferenceQuantize {
  const view = field.parse();
  if (view.kind !== "finite") {
    return { status: "notFinite" };
  }

  const sourceSign = view.sign;
  const sourceCoefficient = view.coefficient;
  const sourceExponent = view.exponent;

  let coefficient: bigint;
  let remainder: bigint;
  const divisor =
    sourceExponent < q ? 10n ** BigInt(q - sourceExponent) : 1n;

  if (sourceExponent >= q) {
    // Exact widening of the coefficient; r is defined to be zero.
    coefficient = sourceCoefficient * 10n ** BigInt(sourceExponent - q);
    remainder = 0n;
  } else {
    coefficient = sourceCoefficient / divisor;
    remainder = sourceCoefficient % divisor;
  }

  if (remainder > 0n) {
    let bump = false;
    if (mode === "towardPositive") {
      bump = sourceSign === 0;
    } else if (mode === "towardNegative") {
      bump = sourceSign === 1;
    } else if (mode === "nearestEven") {
      const twice = 2n * remainder;
      bump = twice > divisor || (twice === divisor && (coefficient & 1n) === 1n);
    } else if (mode === "nearestAway") {
      bump = 2n * remainder >= divisor;
    }
    if (bump) {
      coefficient += 1n;
    }
  }

  if (coefficient > MAX_COEFF) {
    return { status: "invalidQuantize" };
  }

  return {
    status: "ok",
    sign: sourceSign,
    coefficient,
    exponent: q,
    rounded: view.exponent < q,
    inexact: remainder !== 0n,
    sourceNonCanonical: view.nonCanonical,
  };
}

/**
 * Reference ordering by exact cross products of rational magnitudes.
 */
export function referenceCompare(left: Bid128Field, right: Bid128Field): CompareResult {
  const a = left.parse();
  const b = right.parse();
  if (a.kind === "nan" || b.kind === "nan") {
    return "unordered";
  }

  const rankA = a.kind === "infinity" ? (a.sign === 1 ? -1 : 1) : 0;
  const rankB = b.kind === "infinity" ? (b.sign === 1 ? -1 : 1) : 0;
  if (rankA !== 0 || rankB !== 0) {
    if (rankA === rankB) {
      return "equal";
    }
    return rankA < rankB ? "less" : "greater";
  }

  const ra = toRational(a);
  const rb = toRational(b);
  if (typeof ra === "string" || typeof rb === "string") {
    return "unordered";
  }

  if (ra.numerator === 0n && rb.numerator === 0n) {
    return "equal";
  }
  if (ra.sign !== rb.sign) {
    return ra.sign === 1 ? "less" : "greater";
  }

  const lhs = ra.numerator * rb.denominator;
  const rhs = rb.numerator * ra.denominator;
  if (lhs === rhs) {
    return "equal";
  }
  const magnitudeOrder = lhs < rhs ? -1 : 1;
  return ra.sign === 1
    ? (magnitudeOrder < 0 ? "greater" : "less")
    : (magnitudeOrder < 0 ? "less" : "greater");
}

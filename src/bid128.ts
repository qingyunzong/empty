// BID-style decimal128 16-byte field package.
// Closed bit contract for this task only; no Number conversion is ever used
// for the coefficient, exponent, sign or comparison arithmetic.

export const BYTES = 16;

export const MAX_COEFF = 10n ** 34n - 1n; // 9999999999999999999999999999999999
export const EXP_MIN = -6176;
export const EXP_MAX = 6111;
export const EXP_BIAS = 6176;

const SIGN_BIT = 1n << 63n;
const MASK64 = (1n << 64n) - 1n;
const MASK49 = (1n << 49n) - 1n;
const MASK14 = (1n << 14n) - 1n;

export type Sign = 0 | 1;
export type RoundingMode =
  | "towardZero"
  | "towardPositive"
  | "towardNegative"
  | "nearestEven"
  | "nearestAway";

export type FiniteView = {
  kind: "finite";
  sign: Sign;
  coefficient: bigint;
  exponent: number;
  nonCanonical: boolean;
};

export type InfinityView = {
  kind: "infinity";
  sign: Sign;
};

export type NaNView = {
  kind: "nan";
};

export type FieldView = FiniteView | InfinityView | NaNView;

const isSign = (value: unknown): value is Sign => value === 0 || value === 1;

function bytesToU128(bytes: Uint8Array): bigint {
  let u = 0n;
  for (let index = BYTES - 1; index >= 0; index -= 1) {
    const byte = bytes[index];
    if (byte === undefined) {
      throw new RangeError("Bid128Field requires 16 bytes");
    }
    u = (u << 8n) | BigInt(byte);
  }
  return u;
}

function u128ToBytes(u: bigint): Uint8Array {
  const bytes = new Uint8Array(BYTES);
  let remaining = u;
  for (let index = 0; index < BYTES; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

/**
 * An immutable snapshot of one little-endian decimal128 field.
 */
export class Bid128Field {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== BYTES) {
      throw new RangeError(`Bid128Field requires exactly ${BYTES} bytes`);
    }
    this.#bytes = Uint8Array.from(bytes);
  }

 /** Verbatim copy of the original 16 bytes (NaN payload / non-canonical
   * encodings are preserved untouched).
   */
  rawBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }

  parse(): FieldView {
    return parseField(this.#bytes);
  }
}

export function fromBytes(bytes: Uint8Array): Bid128Field {
  return new Bid128Field(bytes);
}

function parseField(source: Uint8Array): FieldView {
  const u = bytesToU128(source);
  const h = u >> 64n;
  const l = u & MASK64;
  const sign: Sign = (h & SIGN_BIT) === 0n ? 0 : 1;
  const combo = Number((h >> 58n) & 31n);

  if (combo === 30) {
    return { kind: "infinity", sign };
  }
  if (combo === 31) {
    return { kind: "nan" };
  }

  const steering = Number((h >> 61n) & 3n);
  if (steering === 3) {
    const exponent = Number((h >> 47n) & MASK14) - EXP_BIAS;
    return {
      kind: "finite",
      sign,
      coefficient: 0n,
      exponent,
      nonCanonical: true,
    };
  }

  const exponent = Number((h >> 49n) & MASK14) - EXP_BIAS;
  const coefficient = ((h & MASK49) << 64n) | l;
  if (coefficient > MAX_COEFF) {
    return {
      kind: "finite",
      sign,
      coefficient: 0n,
      exponent,
      nonCanonical: true,
    };
  }
  return { kind: "finite", sign, coefficient, exponent, nonCanonical: false };
}

/**
 * Canonical ordinary-layout finite field.
 * h = sign*2^63 + (e+6176)*2^49 + high 49 coefficient bits; l = low 64 bits.
 * Trailing coefficient zeros and the requested exponent are never rewritten.
 */
export function Create(sign: Sign, coefficient: bigint, exponent: number): Bid128Field {
  if (!isSign(sign)) {
    throw new RangeError("Create: sign must be 0 or 1");
  }
  if (typeof coefficient !== "bigint" || coefficient < 0n || coefficient > MAX_COEFF) {
    throw new RangeError(`Create: coefficient must be a bigint in [0, 10^34-1]`);
  }
  if (!Number.isInteger(exponent) || exponent < EXP_MIN || exponent > EXP_MAX) {
    throw new RangeError(`Create: exponent must be an integer in [${EXP_MIN}, ${EXP_MAX}]`);
  }

  const h =
    BigInt(sign) * SIGN_BIT +
    BigInt(exponent + EXP_BIAS) * (1n << 49n) +
    (coefficient >> 64n);
  const l = coefficient & MASK64;
  const u = (h << 64n) | l;
  return new Bid128Field(u128ToBytes(u));
}

export type QuantizeOk = {
  status: "ok";
  field: Bid128Field;
  sign: Sign;
  coefficient: bigint;
  exponent: number;
  rounded: boolean;
  inexact: boolean;
  sourceNonCanonical: boolean;
};

export type QuantizeNotFinite = {
  status: "notFinite";
  field: Bid128Field;
};

export type QuantizeInvalid = {
  status: "invalidQuantize";
};

export type QuantizeResult = QuantizeOk | QuantizeNotFinite | QuantizeInvalid;

/**
 * Quantize a finite field so the result exponent is exactly q.
 * The source field is never mutated; the result is a freshly built field.
 */
export function Quantize(
  source: Bid128Field,
  q: number,
  mode: RoundingMode,
): QuantizeResult {
  if (!Number.isInteger(q) || q < EXP_MIN || q > EXP_MAX) {
    throw new RangeError(`Quantize: q must be an integer in [${EXP_MIN}, ${EXP_MAX}]`);
  }
  const modes: ReadonlySet<string> = new Set([
    "towardZero",
    "towardPositive",
    "towardNegative",
    "nearestEven",
    "nearestAway",
  ]);
  if (!modes.has(mode)) {
    throw new RangeError(`Quantize: unsupported rounding mode ${String(mode)}`);
  }

  const view = source.parse();
  if (view.kind !== "finite") {
    // Infinity and NaN do not participate in rounding; bytes pass through.
    return { status: "notFinite", field: new Bid128Field(source.rawBytes()) };
  }

  const sourceNonCanonical = view.nonCanonical;
  // Non-canonical finite encodings decode to signed zero and stay signed zero.
  const sign = view.sign;
  const sourceCoefficient = view.coefficient;
  const sourceExponent = view.exponent;

  let coefficient: bigint;
  let remainder = 0n;
  const rounded = sourceExponent < q;

  if (sourceExponent >= q) {
    coefficient = sourceCoefficient * 10n ** BigInt(sourceExponent - q);
    remainder = 0n;
  } else {
    const divisor = 10n ** BigInt(q - sourceExponent);
    const quotient = sourceCoefficient / divisor;
    remainder = sourceCoefficient % divisor;
    coefficient = quotient;

    if (remainder > 0n) {
      let bump = false;
      if (mode === "towardPositive") {
        bump = sign === 0;
      } else if (mode === "towardNegative") {
        bump = sign === 1;
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
  }

  if (coefficient > MAX_COEFF) {
    // Do not relax the exponent, round to infinity, or emit result bytes.
    return { status: "invalidQuantize" };
  }

  return {
    status: "ok",
    field: Create(sign, coefficient, q),
    sign,
    coefficient,
    exponent: q,
    rounded,
    inexact: remainder !== 0n,
    sourceNonCanonical,
  };
}

export type CompareResult = "less" | "equal" | "greater" | "unordered";

/**
 * Exact decimal comparison on decoded values; never on the raw 128-bit
 * encoding or lexical ordering.
 */
export function NumericCompare(left: Bid128Field, right: Bid128Field): CompareResult {
  const a = left.parse();
  const b = right.parse();
  if (a.kind === "nan" || b.kind === "nan") {
    return "unordered";
  }

  const rankA = infinityRank(a);
  const rankB = infinityRank(b);
  if (rankA !== 0 || rankB !== 0) {
    if (rankA === rankB) {
      return "equal";
    }
    return rankA < rankB ? "less" : "greater";
  }

  const finiteA = a as FiniteView;
  const finiteB = b as FiniteView;

  // Signed zeros (any exponent / quantum) compare equal.
  if (finiteA.coefficient === 0n && finiteB.coefficient === 0n) {
    return "equal";
  }
  if (finiteA.sign !== finiteB.sign) {
    return finiteA.sign === 1 ? "less" : "greater";
  }

  const magnitude = compareMagnitude(finiteA, finiteB);
  if (magnitude === 0) {
    return "equal";
  }
  // Same sign: a larger magnitude is greater when positive, smaller when negative.
  const flip = finiteA.sign === 1;
  if (flip) {
    return magnitude < 0 ? "greater" : "less";
  }
  return magnitude < 0 ? "less" : "greater";
}

function infinityRank(view: FieldView): number {
  if (view.kind !== "infinity") {
    return 0;
  }
  return view.sign === 1 ? -1 : 1;
}

function compareMagnitude(a: FiniteView, b: FiniteView): number {
  // Compare C_a * 10^e_a and C_b * 10^e_b with cross multiplication only.
  if (a.exponent === b.exponent) {
    return a.coefficient === b.coefficient ? 0 : a.coefficient < b.coefficient ? -1 : 1;
  }
  if (a.exponent > b.exponent) {
    const scaledA = a.coefficient * 10n ** BigInt(a.exponent - b.exponent);
    return scaledA === b.coefficient ? 0 : scaledA < b.coefficient ? -1 : 1;
  }
  const scaledB = b.coefficient * 10n ** BigInt(b.exponent - a.exponent);
  return a.coefficient === scaledB ? 0 : a.coefficient < scaledB ? -1 : 1;
}

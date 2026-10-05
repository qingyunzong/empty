/**
 * Dimension vectors over the seven SI base dimensions with integer
 * exponents. Multiplication/division add/subtract vectors; addition and
 * subtraction of quantities require identical vectors.
 */

export const DIM_KEYS = ["M", "L", "T", "I", "Th", "N", "J"] as const;
export type DimKey = (typeof DIM_KEYS)[number];
export type Dims = Record<DimKey, number>;

/** Canonical base-unit symbol for each dimension, in DIM_KEYS order. */
export const BASE_SYMBOLS: Record<DimKey, string> = {
  M: "kg",
  L: "m",
  T: "s",
  I: "A",
  Th: "K",
  N: "mol",
  J: "cd",
};

export function dimsZero(): Dims {
  return { M: 0, L: 0, T: 0, I: 0, Th: 0, N: 0, J: 0 };
}

export function dimsOf(partial: Partial<Dims>): Dims {
  return { ...dimsZero(), ...partial };
}

export function dimsAdd(a: Dims, b: Dims): Dims {
  const out = dimsZero();
  for (const k of DIM_KEYS) out[k] = a[k] + b[k];
  return out;
}

export function dimsSub(a: Dims, b: Dims): Dims {
  const out = dimsZero();
  for (const k of DIM_KEYS) out[k] = a[k] - b[k];
  return out;
}

export function dimsScale(a: Dims, k: number): Dims {
  const out = dimsZero();
  for (const key of DIM_KEYS) out[key] = a[key] * k;
  return out;
}

export function dimsEqual(a: Dims, b: Dims): boolean {
  return DIM_KEYS.every((k) => a[k] === b[k]);
}

export function dimsIsZero(a: Dims): boolean {
  return DIM_KEYS.every((k) => a[k] === 0);
}

/**
 * Canonical unit string, e.g. "kg*m*s^-2", "m*s^-1", "1" for dimensionless.
 * The string is itself parseable by this library and round-trips to the
 * same dimension vector.
 */
export function dimsToUnitString(d: Dims): string {
  const parts: string[] = [];
  for (const k of DIM_KEYS) {
    const e = d[k];
    if (e === 0) continue;
    const sym = BASE_SYMBOLS[k];
    parts.push(e === 1 ? sym : `${sym}^${e}`);
  }
  return parts.length === 0 ? "1" : parts.join("*");
}

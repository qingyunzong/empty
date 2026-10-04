/**
 * Integer dimension vector over the 7 SI base dimensions.
 * Order: L length, M mass, T time, I current, Theta temperature, N amount, J luminosity.
 */
export const DIM_NAMES = ["L", "M", "T", "I", "Theta", "N", "J"] as const;
export const BASE_SYMBOLS = ["m", "kg", "s", "A", "K", "mol", "cd"] as const;
export const DIM_COUNT = 7;

export type Dims = Readonly<Int32Array>;

export function dimsOf(...entries: Array<[number, number]>): Dims {
  const d = new Int32Array(DIM_COUNT);
  for (const [i, e] of entries) d[i] = e;
  return d;
}

export const DIMENSIONLESS: Dims = new Int32Array(DIM_COUNT);

export function dimsAdd(a: Dims, b: Dims): Dims {
  const r = new Int32Array(DIM_COUNT);
  for (let i = 0; i < DIM_COUNT; i++) r[i] = a[i]! + b[i]!;
  return r;
}

export function dimsSub(a: Dims, b: Dims): Dims {
  const r = new Int32Array(DIM_COUNT);
  for (let i = 0; i < DIM_COUNT; i++) r[i] = a[i]! - b[i]!;
  return r;
}

export function dimsScale(a: Dims, k: number): Dims {
  const r = new Int32Array(DIM_COUNT);
  for (let i = 0; i < DIM_COUNT; i++) r[i] = a[i]! * k;
  return r;
}

export function dimsEqual(a: Dims, b: Dims): boolean {
  for (let i = 0; i < DIM_COUNT; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isDimensionless(a: Dims): boolean {
  return dimsEqual(a, DIMENSIONLESS);
}

/** Display order for canonical units: kg, m, s, A, K, mol, cd. */
const DISPLAY_ORDER = [1, 0, 2, 3, 4, 5, 6];

/** Canonical SI unit string, e.g. "m", "kg·m·s^-2", "1/s", "1" for dimensionless. */
export function canonicalUnit(d: Dims): string {
  const pos: string[] = [];
  const neg: string[] = [];
  for (const i of DISPLAY_ORDER) {
    const e = d[i]!;
    if (e === 0) continue;
    const sym = BASE_SYMBOLS[i]!;
    const term = Math.abs(e) === 1 ? sym : `${sym}^${Math.abs(e)}`;
    (e > 0 ? pos : neg).push(term);
  }
  const num = pos.length > 0 ? pos.join("·") : "1";
  if (neg.length === 0) return num === "1" && pos.length === 0 ? "1" : num;
  return `${num}/${neg.join("·")}`;
}

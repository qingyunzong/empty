import { Rational } from "./rational";
import { Dims, dimsOf } from "./dims";

export interface UnitDef {
  /** Scale factor relative to the canonical SI base units. */
  factor: Rational;
  dims: Dims;
}

const L = 0, M = 1, T = 2, I = 3, TH = 4, AMOUNT = 5, LUM = 6;

function u(factor: string | number, ...dims: Array<[number, number]>): UnitDef {
  return { factor: typeof factor === "string" ? Rational.parse(factor) : Rational.of(factor), dims: dimsOf(...dims) };
}

/** Built-in unit table. Values are exact rational multiples of SI base units. */
export const UNITS: Readonly<Record<string, UnitDef>> = {
  // length
  m: u(1, [L, 1]),
  km: u(1000, [L, 1]),
  cm: u("0.01", [L, 1]),
  mm: u("0.001", [L, 1]),
  um: u("1e-6", [L, 1]),
  nm: u("1e-9", [L, 1]),
  // mass
  kg: u(1, [M, 1]),
  g: u("0.001", [M, 1]),
  mg: u("1e-6", [M, 1]),
  t: u(1000, [M, 1]),
  // time
  s: u(1, [T, 1]),
  ms: u("0.001", [T, 1]),
  min: u(60, [T, 1]),
  h: u(3600, [T, 1]),
  d: u(86400, [T, 1]),
  // other base units
  A: u(1, [I, 1]),
  K: u(1, [TH, 1]),
  mol: u(1, [AMOUNT, 1]),
  cd: u(1, [LUM, 1]),
  // volume
  L: u("0.001", [L, 3]),
  mL: u("1e-6", [L, 3]),
  // derived
  Hz: u(1, [T, -1]),
  N: u(1, [M, 1], [L, 1], [T, -2]),
  Pa: u(1, [M, 1], [L, -1], [T, -2]),
  J: u(1, [M, 1], [L, 2], [T, -2]),
  W: u(1, [M, 1], [L, 2], [T, -3]),
  C: u(1, [I, 1], [T, 1]),
  V: u(1, [M, 1], [L, 2], [T, -3], [I, -1]),
};

export function lookupUnit(name: string): UnitDef | undefined {
  return UNITS[name];
}

import { dimsOf, type Dims } from "./dims.js";
import { Rational } from "./rational.js";

export interface UnitDef {
  readonly name: string;
  readonly dims: Dims;
  /** Scale factor relative to the coherent SI base units. */
  readonly scale: Rational;
}

type Row = [name: string, dims: Partial<Dims>, scale: string];

const ROWS: Row[] = [
  // SI base units
  ["m", { L: 1 }, "1"],
  ["kg", { M: 1 }, "1"],
  ["s", { T: 1 }, "1"],
  ["A", { I: 1 }, "1"],
  ["K", { Th: 1 }, "1"],
  ["mol", { N: 1 }, "1"],
  ["cd", { J: 1 }, "1"],
  // gram: 1/1000 kg
  ["g", { M: 1 }, "1/1000"],
  // time aliases
  ["min", { T: 1 }, "60"],
  ["h", { T: 1 }, "3600"],
  ["d", { T: 1 }, "86400"],
  // litre
  ["L", { L: 3 }, "1/1000"],
  ["l", { L: 3 }, "1/1000"],
  // named derived SI units
  ["Hz", { T: -1 }, "1"],
  ["N", { M: 1, L: 1, T: -2 }, "1"],
  ["Pa", { M: 1, L: -1, T: -2 }, "1"],
  ["J", { M: 1, L: 2, T: -2 }, "1"],
  ["W", { M: 1, L: 2, T: -3 }, "1"],
  ["C", { I: 1, T: 1 }, "1"],
  ["V", { M: 1, L: 2, T: -3, I: -1 }, "1"],
  ["F", { M: -1, L: -2, T: 4, I: 2 }, "1"],
  ["ohm", { M: 1, L: 2, T: -3, I: -2 }, "1"],
  ["Ω", { M: 1, L: 2, T: -3, I: -2 }, "1"],
  ["S", { M: -1, L: -2, T: 3, I: 2 }, "1"],
  ["Wb", { M: 1, L: 2, T: -2, I: -1 }, "1"],
  ["T", { M: 1, T: -2, I: -1 }, "1"],
  ["H", { M: 1, L: 2, T: -2, I: -2 }, "1"],
  ["lm", { J: 1 }, "1"],
  ["lx", { J: 1, L: -2 }, "1"],
  ["Bq", { T: -1 }, "1"],
  ["Gy", { L: 2, T: -2 }, "1"],
  ["Sv", { L: 2, T: -2 }, "1"],
  ["kat", { N: 1, T: -1 }, "1"],
];

const PREFIXES: [symbol: string, factor: string][] = [
  ["da", "10"],
  ["h", "100"],
  ["k", "1000"],
  ["M", "1000000"],
  ["G", "1000000000"],
  ["T", "1000000000000"],
  ["P", "1000000000000000"],
  ["E", "1000000000000000000"],
  ["Z", "1000000000000000000000"],
  ["Y", "1000000000000000000000000"],
  ["d", "1/10"],
  ["c", "1/100"],
  ["m", "1/1000"],
  ["u", "1/1000000"],
  ["µ", "1/1000000"],
  ["μ", "1/1000000"],
  ["n", "1/1000000000"],
  ["p", "1/1000000000000"],
  ["f", "1/1000000000000000"],
  ["a", "1/1000000000000000000"],
  ["z", "1/1000000000000000000000"],
  ["y", "1/1000000000000000000000000"],
];

const BASE_TABLE = new Map<string, UnitDef>();
for (const [name, dims, scale] of ROWS) {
  BASE_TABLE.set(name, { name, dims: dimsOf(dims), scale: Rational.parse(scale) });
}

const cache = new Map<string, UnitDef | undefined>();

/**
 * Resolves a unit symbol, trying an exact match first and then a single
 * SI prefix plus a base symbol ("km", "ms", "mg", "kPa", ...).
 */
export function lookupUnit(name: string): UnitDef | undefined {
  const hit = cache.get(name);
  if (hit !== undefined || cache.has(name)) return hit;

  let def = BASE_TABLE.get(name);
  if (def === undefined) {
    // Longest prefix first ("da" before "d").
    for (const [prefix, factor] of PREFIXES) {
      if (!name.startsWith(prefix) || name.length <= prefix.length) continue;
      const rest = name.slice(prefix.length);
      const base = BASE_TABLE.get(rest);
      if (base === undefined) continue;
      def = {
        name,
        dims: base.dims,
        scale: Rational.parse(factor).mul(base.scale),
      };
      break;
    }
  }
  cache.set(name, def);
  return def;
}

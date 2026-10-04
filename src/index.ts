import { parse } from "./parser";
import { evalNode, UnitError } from "./eval";
import { toSTree, sexpr, evalSTree, STree } from "./tree";
import { canonicalUnit, dimsEqual } from "./dims";
import { LexError } from "./lexer";
import { ParseError } from "./parser";
import { Rational } from "./rational";
import { Dims } from "./dims";

export { Rational } from "./rational";
export { canonicalUnit } from "./dims";
export { parse } from "./parser";
export { toSTree, sexpr, evalSTree } from "./tree";
export type { STree } from "./tree";
export type { Quantity } from "./eval";

export interface CalcError {
  message: string;
  /** Half-open range of the offending subexpression in the source. */
  start: number;
  end: number;
  /** Canonical units of the two sides for dimension mismatches. */
  leftUnit?: string;
  rightUnit?: string;
  leftRange?: { start: number; end: number };
  rightRange?: { start: number; end: number };
}

export interface CalcSuccess {
  ok: true;
  /** Exact rational value in canonical SI base units. */
  value: Rational;
  dims: Dims;
  /** Canonical unit string, e.g. "kg·m·s^-2"; "1" if dimensionless. */
  unit: string;
  /** Human-readable result, e.g. "5/2 m/s". */
  display: string;
  /** Small syntax tree (JSON-able) and its S-expression rendering. */
  tree: STree;
  sexpr: string;
  /** True when the independent tree re-evaluation agreed exactly. */
  crossChecked: boolean;
}

export interface CalcFailure {
  ok: false;
  error: CalcError;
}

export type CalcResult = CalcSuccess | CalcFailure;

export function evaluate(src: string): CalcResult {
  let ast;
  try {
    ast = parse(src);
  } catch (e) {
    if (e instanceof LexError || e instanceof ParseError) {
      return { ok: false, error: { message: e.message, start: e.start, end: e.end } };
    }
    throw e;
  }

  const tree = toSTree(ast);

  let main;
  try {
    main = evalNode(ast);
  } catch (e) {
    if (e instanceof UnitError) {
      const error: CalcError = {
        message: e.message, start: e.start, end: e.end,
        ...(e.leftUnit !== undefined ? { leftUnit: e.leftUnit } : {}),
        ...(e.rightUnit !== undefined ? { rightUnit: e.rightUnit } : {}),
        ...(e.leftRange !== undefined ? { leftRange: e.leftRange } : {}),
        ...(e.rightRange !== undefined ? { rightRange: e.rightRange } : {}),
      };
      return { ok: false, error };
    }
    throw e;
  }

  // Cross-check: re-evaluate the serialized small tree independently.
  const check = evalSTree(JSON.parse(JSON.stringify(tree)) as STree);
  const crossChecked = main.value.equals(check.value) && dimsEqual(main.dims, check.dims);
  if (!crossChecked) {
    return {
      ok: false,
      error: {
        message: `internal cross-check failed: ast=${main.value} ${canonicalUnit(main.dims)}`
          + ` vs tree=${check.value} ${canonicalUnit(check.dims)}`,
        start: 0, end: src.length,
      },
    };
  }

  const unit = canonicalUnit(main.dims);
  const display = unit === "1"
    ? main.value.toString()
    : main.value.equals(Rational.ONE)
      ? unit
      : `${main.value} ${unit}`;
  return {
    ok: true,
    value: main.value,
    dims: main.dims,
    unit,
    display,
    tree,
    sexpr: sexpr(tree),
    crossChecked,
  };
}

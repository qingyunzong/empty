/**
 * Condition expressions over request attributes.
 *
 * Semantics:
 *  - A missing attribute (absent key or explicit undefined) evaluates to "unknown".
 *  - Ordering operators (lt/le/gt/ge) are defined only for rationals; any other
 *    operand type yields "unknown" (the comparison cannot be established).
 *  - eq/ne across mismatched types are decidable: eq -> false, ne -> true.
 *  - Boolean connectors use Kleene three-valued logic.
 */

import { cmpRational, isRational, formatRational, type Rational } from "./rational.js";
import { tvlAnd, tvlNot, tvlOfBool, tvlOr, type TVL } from "./tvl.js";

export type AttrValue = boolean | string | Rational;
export type Attrs = Readonly<Record<string, AttrValue | undefined>>;

export type CmpOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

export type Expr =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "cmp"; readonly attr: string; readonly op: CmpOp; readonly value: AttrValue }
  | { readonly kind: "not"; readonly arg: Expr }
  | { readonly kind: "and"; readonly args: readonly Expr[] }
  | { readonly kind: "or"; readonly args: readonly Expr[] };

export const constExpr = (value: boolean): Expr => ({ kind: "const", value });
export const cmp = (attr: string, op: CmpOp, value: AttrValue): Expr => ({
  kind: "cmp",
  attr,
  op,
  value,
});
export const eq = (attr: string, value: AttrValue): Expr => cmp(attr, "eq", value);
export const ne = (attr: string, value: AttrValue): Expr => cmp(attr, "ne", value);
export const lt = (attr: string, value: Rational): Expr => cmp(attr, "lt", value);
export const le = (attr: string, value: Rational): Expr => cmp(attr, "le", value);
export const gt = (attr: string, value: Rational): Expr => cmp(attr, "gt", value);
export const ge = (attr: string, value: Rational): Expr => cmp(attr, "ge", value);
export const not = (arg: Expr): Expr => ({ kind: "not", arg });
export const and = (...args: readonly Expr[]): Expr => ({ kind: "and", args });
export const or = (...args: readonly Expr[]): Expr => ({ kind: "or", args });

function evalCmp(attr: string, op: CmpOp, expected: AttrValue, attrs: Attrs): TVL {
  const actual = attrs[attr];
  if (actual === undefined) return "unknown";

  if (isRational(actual) && isRational(expected)) {
    const c = cmpRational(actual, expected);
    switch (op) {
      case "eq": return tvlOfBool(c === 0);
      case "ne": return tvlOfBool(c !== 0);
      case "lt": return tvlOfBool(c < 0);
      case "le": return tvlOfBool(c <= 0);
      case "gt": return tvlOfBool(c > 0);
      case "ge": return tvlOfBool(c >= 0);
    }
  }

  const sameKind = typeof actual === typeof expected;
  switch (op) {
    case "eq":
      return tvlOfBool(sameKind && actual === expected);
    case "ne":
      return tvlOfBool(!(sameKind && actual === expected));
    default:
      // Ordering is only meaningful for rationals; anything else is unknowable.
      return "unknown";
  }
}

export function evalExpr(expr: Expr, attrs: Attrs): TVL {
  switch (expr.kind) {
    case "const":
      return tvlOfBool(expr.value);
    case "cmp":
      return evalCmp(expr.attr, expr.op, expr.value, attrs);
    case "not":
      return tvlNot(evalExpr(expr.arg, attrs));
    case "and":
      return tvlAnd(...expr.args.map((a) => evalExpr(a, attrs)));
    case "or":
      return tvlOr(...expr.args.map((a) => evalExpr(a, attrs)));
  }
}

function formatValue(v: AttrValue): string {
  if (isRational(v)) return formatRational(v);
  return JSON.stringify(v);
}

export function formatExpr(expr: Expr): string {
  switch (expr.kind) {
    case "const":
      return String(expr.value);
    case "cmp":
      return `${expr.attr} ${expr.op} ${formatValue(expr.value)}`;
    case "not":
      return `not (${formatExpr(expr.arg)})`;
    case "and":
      return `(${expr.args.map(formatExpr).join(" and ")})`;
    case "or":
      return `(${expr.args.map(formatExpr).join(" or ")})`;
  }
}

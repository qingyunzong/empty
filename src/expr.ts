/**
 * Boolean expressions over field values.
 *
 * Semantics: a hidden field is treated as unfilled (its value is `undefined`).
 * During the fixpoint computation fields only ever transition hidden -> visible,
 * so an expression is *monotone* iff its truth value can only flip false -> true
 * as more fields become visible. Non-monotone expressions (e.g. `not(filled(x))`,
 * `neq(x, v)`) are rejected by `assertMonotone`.
 */

export type Expr =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "filled"; readonly field: string }
  | { readonly kind: "value"; readonly field: string }
  | { readonly kind: "eq"; readonly field: string; readonly value: unknown }
  | { readonly kind: "neq"; readonly field: string; readonly value: unknown }
  | { readonly kind: "cmp"; readonly op: CmpOp; readonly field: string; readonly value: number }
  | { readonly kind: "and"; readonly args: readonly Expr[] }
  | { readonly kind: "or"; readonly args: readonly Expr[] }
  | { readonly kind: "not"; readonly arg: Expr };

export type CmpOp = "<" | "<=" | ">" | ">=";

/** Convenience builders. */
export const E = {
  const: (value: boolean): Expr => ({ kind: "const", value }),
  filled: (field: string): Expr => ({ kind: "filled", field }),
  value: (field: string): Expr => ({ kind: "value", field }),
  eq: (field: string, value: unknown): Expr => ({ kind: "eq", field, value }),
  neq: (field: string, value: unknown): Expr => ({ kind: "neq", field, value }),
  cmp: (op: CmpOp, field: string, value: number): Expr => ({ kind: "cmp", op, field, value }),
  and: (...args: Expr[]): Expr => ({ kind: "and", args }),
  or: (...args: Expr[]): Expr => ({ kind: "or", args }),
  not: (arg: Expr): Expr => ({ kind: "not", arg }),
} as const;

/** All field names referenced by the expression. */
export function fieldRefs(expr: Expr, out: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case "const":
      break;
    case "filled":
    case "value":
    case "eq":
    case "neq":
    case "cmp":
      out.add(expr.field);
      break;
    case "and":
    case "or":
      for (const arg of expr.args) fieldRefs(arg, out);
      break;
    case "not":
      fieldRefs(expr.arg, out);
      break;
  }
  return out;
}

/** True iff the expression does not depend on any field (hence not on visibility). */
export function isVisibilityIndependent(expr: Expr): boolean {
  return fieldRefs(expr).size === 0;
}

export interface MonotoneViolation {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Structural monotonicity check with respect to the hidden -> visible lattice.
 *
 * Monotone primitives: `filled`, `value` (truthiness), `eq`, `cmp` — all are
 * false while the referenced field is hidden and can only flip to true.
 * `and`/`or` preserve monotonicity. `not` is only allowed around
 * visibility-independent subexpressions. `neq` referencing a field is
 * non-monotone (true while hidden, may flip to false) and is rejected.
 */
export function checkMonotone(expr: Expr): { readonly ok: true } | MonotoneViolation {
  switch (expr.kind) {
    case "const":
    case "filled":
    case "value":
    case "eq":
    case "cmp":
      return { ok: true };
    case "neq":
      return {
        ok: false,
        reason: `neq on field "${expr.field}" is non-monotone: it is true while the field is hidden and may flip to false once visible`,
      };
    case "and":
    case "or":
      for (const arg of expr.args) {
        const res = checkMonotone(arg);
        if (!res.ok) return res;
      }
      return { ok: true };
    case "not":
      if (isVisibilityIndependent(expr.arg)) return { ok: true };
      return {
        ok: false,
        reason: `not(...) wraps a visibility-dependent expression, which is non-monotone over hidden references`,
      };
  }
}

export function assertMonotone(expr: Expr, context: string): void {
  const res = checkMonotone(expr);
  if (!res.ok) {
    throw new NonMonotoneConditionError(`${context}: ${res.reason}`);
  }
}

export class NonMonotoneConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonMonotoneConditionError";
  }
}

/** Evaluation context: resolves a field to its visibility and current value. */
export type FieldLookup = (field: string) => { readonly visible: boolean; readonly value: unknown };

const UNFILLED = undefined;

export function evaluate(expr: Expr, lookup: FieldLookup): boolean {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "filled": {
      const f = lookup(expr.field);
      return f.visible && f.value !== UNFILLED && f.value !== null;
    }
    case "value": {
      const f = lookup(expr.field);
      return f.visible && Boolean(f.value);
    }
    case "eq": {
      const f = lookup(expr.field);
      return f.visible && f.value === expr.value;
    }
    case "neq": {
      const f = lookup(expr.field);
      return !f.visible || f.value !== expr.value;
    }
    case "cmp": {
      const f = lookup(expr.field);
      if (!f.visible || typeof f.value !== "number") return false;
      switch (expr.op) {
        case "<":
          return f.value < expr.value;
        case "<=":
          return f.value <= expr.value;
        case ">":
          return f.value > expr.value;
        case ">=":
          return f.value >= expr.value;
      }
      break;
    }
    case "and":
      return expr.args.every((a) => evaluate(a, lookup));
    case "or":
      return expr.args.some((a) => evaluate(a, lookup));
    case "not":
      return !evaluate(expr.arg, lookup);
  }
}

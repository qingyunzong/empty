import { Value, Tri, triOf, triNot, triAnd, triOr, sqlEq, sqlCmp, U } from "./values.js";

/** Scalar / predicate expression tree. */
export type Expr =
  | { kind: "lit"; value: Value }
  | { kind: "col"; name: string }
  | { kind: "add" | "sub" | "mul"; left: Expr; right: Expr }
  | { kind: "cmp"; op: "=" | "!=" | "<" | "<=" | ">" | ">="; left: Expr; right: Expr }
  | { kind: "isNull"; arg: Expr }
  | { kind: "isNotNull"; arg: Expr }
  | { kind: "and" | "or"; args: Expr[] }
  | { kind: "not"; arg: Expr };

export const lit = (value: Value): Expr => ({ kind: "lit", value });
export const col = (name: string): Expr => ({ kind: "col", name });
export const eq = (l: Expr, r: Expr): Expr => ({ kind: "cmp", op: "=", left: l, right: r });
export const lt = (l: Expr, r: Expr): Expr => ({ kind: "cmp", op: "<", left: l, right: r });
export const gt = (l: Expr, r: Expr): Expr => ({ kind: "cmp", op: ">", left: l, right: r });
export const and = (...args: Expr[]): Expr => ({ kind: "and", args });
export const or = (...args: Expr[]): Expr => ({ kind: "or", args });
export const not = (arg: Expr): Expr => ({ kind: "not", arg });
export const isNull = (arg: Expr): Expr => ({ kind: "isNull", arg });
export const isNotNull = (arg: Expr): Expr => ({ kind: "isNotNull", arg });

export type Row = Record<string, Value>;

/** Evaluate a scalar-valued expression; NULL propagates through arithmetic. */
export function evalScalar(e: Expr, row: Row): Value {
  switch (e.kind) {
    case "lit": return e.value;
    case "col": {
      const v = row[e.name];
      return v === undefined ? null : v;
    }
    case "add": case "sub": case "mul": {
      const l = evalScalar(e.left, row);
      const r = evalScalar(e.right, row);
      if (typeof l !== "number" || typeof r !== "number") return null;
      return e.kind === "add" ? l + r : e.kind === "sub" ? l - r : l * r;
    }
    default:
      // Predicate used in scalar position: TRUE->1, else NULL-safe falsey 0.
      return evalPred(e, row) === "true" ? 1 : 0;
  }
}

/** Evaluate a predicate under SQL three-valued logic. */
export function evalPred(e: Expr, row: Row): Tri {
  switch (e.kind) {
    case "cmp": {
      const l = evalScalar(e.left, row);
      const r = evalScalar(e.right, row);
      if (e.op === "=") return sqlEq(l, r);
      if (e.op === "!=") return triNot(sqlEq(l, r));
      return sqlCmp(e.op, l, r);
    }
    case "isNull": return triOf(evalScalar(e.arg, row) === null);
    case "isNotNull": return triOf(evalScalar(e.arg, row) !== null);
    case "and": {
      let acc: Tri = "true";
      for (const a of e.args) acc = triAnd(acc, evalPred(a, row));
      return acc;
    }
    case "or": {
      let acc: Tri = "false";
      for (const a of e.args) acc = triOr(acc, evalPred(a, row));
      return acc;
    }
    case "not": return triNot(evalPred(e.arg, row));
    default: {
      // Scalar used as predicate: nonzero number is TRUE, NULL is UNKNOWN.
      const v = evalScalar(e, row);
      if (v === null) return U;
      return triOf(v !== 0 && v !== false && v !== "");
    }
  }
}

/** Columns referenced by an expression. */
export function referencedColumns(e: Expr): Set<string> {
  const out = new Set<string>();
  const walk = (x: Expr): void => {
    switch (x.kind) {
      case "col": out.add(x.name); break;
      case "add": case "sub": case "mul": case "cmp": walk(x.left); walk(x.right); break;
      case "isNull": case "isNotNull": case "not": walk(x.arg); break;
      case "and": case "or": x.args.forEach(walk); break;
      case "lit": break;
    }
  };
  walk(e);
  return out;
}

/**
 * Public, checkable precondition: predicate `e` is NULL-rejecting w.r.t.
 * columns `cols` iff it can never evaluate to TRUE when every column in
 * `cols` is NULL. Evaluated directly on the all-NULL row; exact for this
 * expression language because 3VL evaluation is deterministic and total.
 */
export function isNullRejecting(e: Expr, cols: readonly string[]): boolean {
  const nullRow: Row = {};
  for (const c of cols) nullRow[c] = null;
  return evalPred(e, nullRow) !== "true";
}

/** Split a predicate into top-level AND conjuncts. */
export function conjuncts(e: Expr): Expr[] {
  return e.kind === "and" ? e.args.flatMap(conjuncts) : [e];
}

/** Render an expression for certificates / debugging. */
export function showExpr(e: Expr): string {
  switch (e.kind) {
    case "lit": return e.value === null ? "NULL" : JSON.stringify(e.value);
    case "col": return e.name;
    case "add": return `(${showExpr(e.left)} + ${showExpr(e.right)})`;
    case "sub": return `(${showExpr(e.left)} - ${showExpr(e.right)})`;
    case "mul": return `(${showExpr(e.left)} * ${showExpr(e.right)})`;
    case "cmp": return `(${showExpr(e.left)} ${e.op} ${showExpr(e.right)})`;
    case "isNull": return `(${showExpr(e.arg)} IS NULL)`;
    case "isNotNull": return `(${showExpr(e.arg)} IS NOT NULL)`;
    case "and": return `(${e.args.map(showExpr).join(" AND ")})`;
    case "or": return `(${e.args.map(showExpr).join(" OR ")})`;
    case "not": return `(NOT ${showExpr(e.arg)})`;
  }
}

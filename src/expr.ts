/**
 * Expression AST and evaluation under SQL three-valued logic (3VL).
 *
 * Any comparison involving NULL evaluates to UNKNOWN. WHERE / JOIN ... ON
 * keep a row only when the condition is TRUE. AND/OR/NOT follow the
 * standard SQL truth tables.
 */

import { compareValues, type Row, type Value } from "./values.js";

/** A joined tuple: one scope per source table, in join order. */
export interface Scope {
  table: string;
  rec: Row;
}
export type Tuple = Scope[];

export class QueryError extends Error {}

export type BinOp = "=" | "<>" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*";

export type Expr =
  | { kind: "col"; name: string }
  | { kind: "lit"; value: Value }
  | { kind: "bin"; op: BinOp; left: Expr; right: Expr }
  | { kind: "logic"; op: "and" | "or"; args: Expr[] }
  | { kind: "not"; arg: Expr }
  | { kind: "isnull"; arg: Expr };

/** Three-valued truth value. */
export type Tri = boolean | "unknown";

const BIN_OPS: ReadonlySet<string> = new Set([
  "=", "<>", "<", "<=", ">", ">=", "+", "-", "*",
]);

/** Parse an expression from its JSON form. */
export function parseExpr(node: unknown): Expr {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new QueryError(`invalid expression: ${JSON.stringify(node)}`);
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.col === "string") {
    return { kind: "col", name: obj.col };
  }
  if ("lit" in obj) {
    const v = obj.lit as Value;
    if (
      v !== null &&
      typeof v !== "boolean" &&
      typeof v !== "bigint" &&
      typeof v !== "number" &&
      typeof v !== "string"
    ) {
      throw new QueryError(`unsupported literal: ${JSON.stringify(obj.lit)}`);
    }
    return { kind: "lit", value: v };
  }
  if (typeof obj.op === "string") {
    const op = obj.op;
    if (BIN_OPS.has(op)) {
      return {
        kind: "bin",
        op: op as BinOp,
        left: parseExpr(obj.left),
        right: parseExpr(obj.right),
      };
    }
    if (op === "and" || op === "or") {
      if (!Array.isArray(obj.args)) {
        throw new QueryError(`"${op}" requires an "args" array`);
      }
      return { kind: "logic", op, args: obj.args.map(parseExpr) };
    }
    if (op === "not") {
      return { kind: "not", arg: parseExpr(obj.arg) };
    }
    if (op === "isnull") {
      return { kind: "isnull", arg: parseExpr(obj.arg) };
    }
    throw new QueryError(`unknown operator "${op}"`);
  }
  throw new QueryError(`invalid expression: ${JSON.stringify(node)}`);
}

/** Resolve a column reference against a joined tuple. */
export function resolveColumn(tuple: Tuple, name: string): Value {
  if (name.includes(".")) {
    const dot = name.indexOf(".");
    const table = name.slice(0, dot);
    const col = name.slice(dot + 1);
    const scope = tuple.find((s) => s.table === table);
    if (!scope) {
      throw new QueryError(`unknown table "${table}" in column "${name}"`);
    }
    if (!(col in scope.rec)) {
      throw new QueryError(`unknown column "${name}"`);
    }
    return scope.rec[col] as Value;
  }
  let found: Value | undefined;
  let count = 0;
  for (const scope of tuple) {
    if (name in scope.rec) {
      found = scope.rec[name];
      count += 1;
    }
  }
  if (count === 0) throw new QueryError(`unknown column "${name}"`);
  if (count > 1) throw new QueryError(`ambiguous column "${name}"`);
  return found as Value;
}

function isNumeric(v: Value): v is bigint | number {
  return typeof v === "bigint" || typeof v === "number";
}

function arithmetic(op: BinOp, a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  if (!isNumeric(a) || !isNumeric(b)) {
    throw new QueryError(
      `operator "${op}" requires numbers, got ${typeof a} and ${typeof b}`,
    );
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
    }
  }
  const x = Number(a);
  const y = Number(b);
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
  }
  throw new QueryError(`operator "${op}" is not arithmetic`);
}

function compare(op: BinOp, a: Value, b: Value): Tri {
  if (a === null || b === null) return "unknown";
  const c = compareValues(a, b);
  switch (op) {
    case "=": return c === 0;
    case "<>": return c !== 0;
    case "<": return c < 0;
    case "<=": return c <= 0;
    case ">": return c > 0;
    case ">=": return c >= 0;
  }
  throw new QueryError(`operator "${op}" is not a comparison`);
}

/** Coerce an arbitrary value to a 3VL truth value (boolean context). */
function toTri(v: Value): Tri {
  if (v === null) return "unknown";
  if (typeof v === "boolean") return v;
  throw new QueryError(`expected a boolean condition, got ${typeof v}`);
}

function triNot(t: Tri): Tri {
  if (t === "unknown") return "unknown";
  return !t;
}

function triAnd(a: Tri, b: Tri): Tri {
  if (a === false || b === false) return false;
  if (a === "unknown" || b === "unknown") return "unknown";
  return true;
}

function triOr(a: Tri, b: Tri): Tri {
  if (a === true || b === true) return true;
  if (a === "unknown" || b === "unknown") return "unknown";
  return false;
}

/** Evaluate an expression to a value on a joined tuple. */
export function evalExpr(expr: Expr, tuple: Tuple): Value {
  switch (expr.kind) {
    case "col":
      return resolveColumn(tuple, expr.name);
    case "lit":
      return expr.value;
    case "bin": {
      const l = evalExpr(expr.left, tuple);
      const r = evalExpr(expr.right, tuple);
      if (expr.op === "+" || expr.op === "-" || expr.op === "*") {
        return arithmetic(expr.op, l, r);
      }
      const t = compare(expr.op, l, r);
      return t === "unknown" ? null : t;
    }
    case "logic": {
      let acc: Tri = expr.op === "and" ? true : false;
      for (const arg of expr.args) {
        const t = toTri(evalExpr(arg, tuple));
        acc = expr.op === "and" ? triAnd(acc, t) : triOr(acc, t);
      }
      return acc === "unknown" ? null : acc;
    }
    case "not": {
      const t = triNot(toTri(evalExpr(expr.arg, tuple)));
      return t === "unknown" ? null : t;
    }
    case "isnull":
      return evalExpr(expr.arg, tuple) === null;
  }
}

/** Evaluate a boolean condition; UNKNOWN and FALSE both exclude the row. */
export function passes(cond: Expr, tuple: Tuple): boolean {
  return toTri(evalExpr(cond, tuple)) === true;
}

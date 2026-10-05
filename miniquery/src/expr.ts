/** Expression evaluation with SQL three-valued logic. */

import { QueryError, type Expr, type Row, type Value } from "./types.js";
import {
  compare3,
  toValue,
  triAnd,
  triNot,
  triOr,
  valuesEqual,
  type Tri,
} from "./values.js";

/** Column names referenced by an expression, as written (qualified or not). */
export function exprColumns(e: Expr, out: Set<string> = new Set()): Set<string> {
  if ("col" in e) out.add(e.col);
  else if ("args" in e) for (const a of e.args) exprColumns(a, out);
  else if ("arg" in e) exprColumns(e.arg, out);
  return out;
}

/** Evaluate a boolean expression to a three-valued result. */
export function evalPredicate(e: Expr, row: Row, resolve: (name: string) => string): Tri {
  if ("op" in e) {
    switch (e.op) {
      case "and": {
        let acc: Tri = true;
        for (const a of e.args) {
          acc = triAnd(acc, evalPredicate(a, row, resolve));
          if (acc === false) return false;
        }
        return acc;
      }
      case "or": {
        let acc: Tri = false;
        for (const a of e.args) {
          acc = triOr(acc, evalPredicate(a, row, resolve));
          if (acc === true) return true;
        }
        return acc;
      }
      case "not":
        return triNot(evalPredicate(e.arg, row, resolve));
      case "isNull":
        return evalValue(e.arg, row, resolve) === null;
      case "isNotNull":
        return evalValue(e.arg, row, resolve) !== null;
      case "eq":
      case "ne": {
        const l = evalValue(e.args[0], row, resolve);
        const r = evalValue(e.args[1], row, resolve);
        const eq = valuesEqual(l, r);
        return e.op === "eq" ? eq : triNot(eq);
      }
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        const l = evalValue(e.args[0], row, resolve);
        const r = evalValue(e.args[1], row, resolve);
        const c = compare3(l, r);
        if (c === null) return null;
        switch (e.op) {
          case "lt": return c < 0;
          case "le": return c <= 0;
          case "gt": return c > 0;
          case "ge": return c >= 0;
        }
      }
    }
  }
  const v = evalValue(e, row, resolve);
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  throw new QueryError(`predicate must be boolean, got ${typeof v}`);
}

/** Evaluate any expression to a value. */
export function evalValue(e: Expr, row: Row, resolve: (name: string) => string): Value {
  if ("lit" in e) return toValue(e.lit);
  if ("col" in e) {
    const key = resolve(e.col);
    const v = row.get(key);
    if (v === undefined) throw new QueryError(`unknown column: ${e.col}`);
    return v;
  }
  if ("op" in e && (e.op === "isNull" || e.op === "isNotNull")) {
    return evalPredicate(e, row, resolve);
  }
  const t = evalPredicate(e, row, resolve);
  return t === null ? null : t;
}

/** Build a resolver mapping (possibly unqualified) column names to row keys. */
export function makeResolver(aliases: Map<string, string[]>): (name: string) => string {
  return (name: string): string => {
    if (name.includes(".")) {
      const cols = aliases.get(name.slice(0, name.indexOf(".")));
      if (cols && cols.includes(name)) return name;
      throw new QueryError(`unknown column: ${name}`);
    }
    let found: string | null = null;
    for (const cols of aliases.values()) {
      for (const qualified of cols) {
        if (qualified.slice(qualified.indexOf(".") + 1) === name) {
          if (found !== null && found !== qualified) {
            throw new QueryError(`ambiguous column: ${name}`);
          }
          found = qualified;
        }
      }
    }
    if (found === null) throw new QueryError(`unknown column: ${name}`);
    return found;
  };
}

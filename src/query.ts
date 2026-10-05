/**
 * Query definition and JSON parsing.
 *
 * Query JSON shape:
 * {
 *   "from": "table",
 *   "joins":  [ { "table": "t2", "on": <expr> } ],          // inner joins
 *   "where":  <expr>,
 *   "groupBy": [ "col", "t2.col" ],
 *   "select": [ { "col": "name", "as": "out" },
 *               { "agg": "count|sum|avg|min|max",
 *                 "arg": "*" | <expr>, "as": "out" } ]
 * }
 */

import { parseExpr, QueryError, type Expr } from "./expr.js";

export type AggFunc = "count" | "sum" | "avg" | "min" | "max";

export interface SelectCol {
  kind: "col";
  name: string;
  as: string;
}

export interface SelectAgg {
  kind: "agg";
  func: AggFunc;
  arg: Expr | "*";
  as: string;
}

export type SelectItem = SelectCol | SelectAgg;

export interface Join {
  table: string;
  on: Expr;
}

export interface Query {
  from: string;
  joins: Join[];
  where: Expr | null;
  groupBy: string[];
  select: SelectItem[];
}

const AGG_FUNCS: ReadonlySet<string> = new Set(["count", "sum", "avg", "min", "max"]);

function parseSelectItem(node: unknown): SelectItem {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new QueryError("select items must be objects");
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.col === "string") {
    const as = obj.as === undefined ? obj.col : obj.as;
    if (typeof as !== "string") throw new QueryError('"as" must be a string');
    return { kind: "col", name: obj.col, as };
  }
  if (typeof obj.agg === "string") {
    const func = obj.agg;
    if (!AGG_FUNCS.has(func)) {
      throw new QueryError(`unknown aggregate "${func}"`);
    }
    const as = obj.as === undefined ? func : obj.as;
    if (typeof as !== "string") throw new QueryError('"as" must be a string');
    if (obj.arg === "*") {
      if (func !== "count") {
        throw new QueryError(`aggregate "${func}" does not accept "*"`);
      }
      return { kind: "agg", func: func as AggFunc, arg: "*", as };
    }
    if (obj.arg === undefined) {
      throw new QueryError(`aggregate "${func}" requires "arg"`);
    }
    return { kind: "agg", func: func as AggFunc, arg: parseExpr(obj.arg), as };
  }
  throw new QueryError(`invalid select item: ${JSON.stringify(node)}`);
}

/** Parse a query from its JSON form. */
export function parseQuery(node: unknown): Query {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new QueryError("query must be a JSON object");
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.from !== "string") {
    throw new QueryError('query requires a "from" table name');
  }
  const joins: Join[] = [];
  if (obj.joins !== undefined) {
    if (!Array.isArray(obj.joins)) {
      throw new QueryError('"joins" must be an array');
    }
    for (const j of obj.joins) {
      if (j === null || typeof j !== "object" || typeof j.table !== "string") {
        throw new QueryError('each join requires a "table" name');
      }
      if (j.on === undefined) {
        throw new QueryError('each join requires an "on" condition');
      }
      joins.push({ table: j.table, on: parseExpr(j.on) });
    }
  }
  const where = obj.where === undefined ? null : parseExpr(obj.where);
  const groupBy: string[] = [];
  if (obj.groupBy !== undefined) {
    if (!Array.isArray(obj.groupBy) || !obj.groupBy.every((c) => typeof c === "string")) {
      throw new QueryError('"groupBy" must be an array of column names');
    }
    groupBy.push(...(obj.groupBy as string[]));
  }
  if (!Array.isArray(obj.select) || obj.select.length === 0) {
    throw new QueryError('query requires a non-empty "select" array');
  }
  const select = obj.select.map(parseSelectItem);
  const names = new Set<string>();
  for (const item of select) {
    if (names.has(item.as)) {
      throw new QueryError(`duplicate output column "${item.as}"`);
    }
    names.add(item.as);
  }
  const hasAgg = select.some((s) => s.kind === "agg");
  if (hasAgg || groupBy.length > 0) {
    for (const item of select) {
      if (item.kind === "col" && !groupBy.includes(item.name)) {
        throw new QueryError(
          `column "${item.name}" must appear in "groupBy" to be selected`,
        );
      }
    }
  }
  return { from: obj.from, joins, where, groupBy, select };
}

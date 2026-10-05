/**
 * Main query engine: hash join (when the ON condition contains usable
 * equality conjuncts) and hash-based grouping. Output rows are sorted by
 * all output columns under a total order, so results are deterministic.
 */

import {
  evalExpr,
  passes,
  resolveColumn,
  QueryError,
  type Expr,
  type Tuple,
} from "./expr.js";
import type { Query, SelectAgg } from "./query.js";
import {
  compareValues,
  valueKey,
  type Database,
  type Row,
  type Value,
} from "./values.js";

function scanTable(db: Database, name: string): Row[] {
  const rows = db.tables[name];
  if (!rows) throw new QueryError(`unknown table "${name}"`);
  return rows;
}

/** Split an expression into top-level AND conjuncts. */
function conjuncts(expr: Expr): Expr[] {
  if (expr.kind === "logic" && expr.op === "and") {
    return expr.args.flatMap(conjuncts);
  }
  return [expr];
}

/**
 * If `expr` is `colA = colB`, determine which side of the join each column
 * belongs to and return [leftKey, rightKey], else null. The left key is a
 * column name resolvable against left tuples; the right key is the bare
 * column name inside right-table records.
 */
function equalityKeys(
  expr: Expr,
  leftTables: Set<string>,
  rightTable: string,
  rightCols: Set<string>,
  leftBareCols: Set<string>,
): [string, string] | null {
  if (expr.kind !== "bin" || expr.op !== "=") return null;
  if (expr.left.kind !== "col" || expr.right.kind !== "col") return null;
  const side = (name: string): "left" | "right" | "both" | "none" => {
    if (name.includes(".")) {
      const table = name.slice(0, name.indexOf("."));
      if (table === rightTable) return "right";
      if (leftTables.has(table)) return "left";
      return "none";
    }
    const inLeft = leftBareCols.has(name);
    const inRight = rightCols.has(name);
    if (inLeft && inRight) return "both";
    if (inLeft) return "left";
    if (inRight) return "right";
    return "none";
  };
  const bare = (name: string): string =>
    name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  const ls = side(expr.left.name);
  const rs = side(expr.right.name);
  if (ls === "left" && rs === "right") return [expr.left.name, bare(expr.right.name)];
  if (ls === "right" && rs === "left") return [expr.right.name, bare(expr.left.name)];
  return null;
}

function joinTuples(
  left: Tuple[],
  leftTables: Set<string>,
  rightTable: string,
  rightRows: Row[],
  on: Expr,
): Tuple[] {
  const rightCols = new Set<string>();
  for (const r of rightRows) {
    for (const c of Object.keys(r)) rightCols.add(c);
  }
  const leftBareCols = new Set<string>();
  for (const t of left) {
    for (const s of t) {
      for (const c of Object.keys(s.rec)) leftBareCols.add(c);
    }
  }

  const all = conjuncts(on);
  const keyPairs: [string, string][] = [];
  const residual: Expr[] = [];
  for (const c of all) {
    const pair = equalityKeys(c, leftTables, rightTable, rightCols, leftBareCols);
    if (pair) keyPairs.push(pair);
    else residual.push(c);
  }
  const residualOk = (t: Tuple): boolean => residual.every((c) => passes(c, t));

  const out: Tuple[] = [];
  if (keyPairs.length > 0) {
    // Hash join: build on right, probe with left. NULL keys never match
    // because NULL = NULL is UNKNOWN, not TRUE.
    const buckets = new Map<string, Row[]>();
    for (const r of rightRows) {
      const vals = keyPairs.map(([, rk]) => r[rk] as Value);
      if (vals.some((v) => v === null || v === undefined)) continue;
      const key = vals.map(valueKey).join(" ");
      const bucket = buckets.get(key);
      if (bucket) bucket.push(r);
      else buckets.set(key, [r]);
    }
    for (const lt of left) {
      const vals = keyPairs.map(([lk]) => resolveColumn(lt, lk));
      if (vals.some((v) => v === null)) continue;
      const key = vals.map(valueKey).join(" ");
      const bucket = buckets.get(key);
      if (!bucket) continue;
      for (const r of bucket) {
        const joined: Tuple = [...lt, { table: rightTable, rec: r }];
        if (residualOk(joined)) out.push(joined);
      }
    }
  } else {
    // Fallback: nested loop when no usable equality conjunct exists.
    for (const lt of left) {
      for (const r of rightRows) {
        const joined: Tuple = [...lt, { table: rightTable, rec: r }];
        if (passes(on, joined)) out.push(joined);
      }
    }
  }
  return out;
}

function isNumeric(v: Value): v is bigint | number {
  return typeof v === "bigint" || typeof v === "number";
}

/** Compute one aggregate over a group of tuples. */
function aggregate(item: SelectAgg, tuples: Tuple[]): Value {
  if (item.func === "count") {
    if (item.arg === "*") return BigInt(tuples.length);
    let n = 0n;
    for (const t of tuples) {
      if (evalExpr(item.arg, t) !== null) n += 1n;
    }
    return n;
  }
  const arg = item.arg as Expr;
  if (item.func === "sum" || item.func === "avg") {
    let intSum = 0n;
    let floatSum = 0;
    let isFloat = false;
    let n = 0;
    for (const t of tuples) {
      const v = evalExpr(arg, t);
      if (v === null) continue;
      if (!isNumeric(v)) {
        throw new QueryError(`aggregate "${item.func}" requires numbers`);
      }
      n += 1;
      if (typeof v === "bigint" && !isFloat) {
        intSum += v;
      } else {
        if (!isFloat) {
          floatSum = Number(intSum);
          isFloat = true;
        }
        floatSum += Number(v);
      }
    }
    if (n === 0) return null;
    if (item.func === "sum") return isFloat ? floatSum : intSum;
    // AVG over integers stays exact when the quotient is integral.
    if (!isFloat) {
      const count = BigInt(n);
      if (intSum % count === 0n) return intSum / count;
    }
    const total = isFloat ? floatSum : Number(intSum);
    return total / n;
  }
  // min / max
  let best: Value = null;
  for (const t of tuples) {
    const v = evalExpr(arg, t);
    if (v === null) continue;
    if (best === null) {
      best = v;
    } else {
      const c = compareValues(v, best);
      if (item.func === "min" ? c < 0 : c > 0) best = v;
    }
  }
  return best;
}

function project(tuples: Tuple[], query: Query): Row[] {
  const hasAgg = query.select.some((s) => s.kind === "agg");
  if (query.groupBy.length === 0 && !hasAgg) {
    return tuples.map((t) => {
      const row: Row = {};
      for (const item of query.select) {
        if (item.kind === "col") row[item.as] = resolveColumn(t, item.name);
      }
      return row;
    });
  }

  interface Group {
    keyVals: Value[];
    tuples: Tuple[];
  }
  const groups = new Map<string, Group>();
  if (query.groupBy.length === 0) {
    groups.set("", { keyVals: [], tuples: [...tuples] });
  } else {
    for (const t of tuples) {
      const keyVals = query.groupBy.map((c) => resolveColumn(t, c));
      const key = keyVals.map(valueKey).join(" ");
      const g = groups.get(key);
      if (g) g.tuples.push(t);
      else groups.set(key, { keyVals, tuples: [t] });
    }
  }

  const out: Row[] = [];
  for (const g of groups.values()) {
    const row: Row = {};
    for (const item of query.select) {
      if (item.kind === "col") {
        const idx = query.groupBy.indexOf(item.name);
        row[item.as] = g.keyVals[idx] as Value;
      } else {
        row[item.as] = aggregate(item, g.tuples);
      }
    }
    out.push(row);
  }
  return out;
}

/** Sort rows by all output columns under the deterministic total order. */
function sortRows(rows: Row[], columns: string[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const col of columns) {
      const c = compareValues(a[col] as Value, b[col] as Value);
      if (c !== 0) return c;
    }
    return 0;
  });
}

/** Execute a query and return deterministically sorted rows. */
export function runQuery(db: Database, query: Query): Row[] {
  let tuples: Tuple[] = scanTable(db, query.from).map((rec) => [
    { table: query.from, rec },
  ]);
  const tables = new Set<string>([query.from]);
  for (const join of query.joins) {
    if (tables.has(join.table)) {
      throw new QueryError(`table "${join.table}" joined twice`);
    }
    const rightRows = scanTable(db, join.table);
    tuples = joinTuples(tuples, tables, join.table, rightRows, join.on);
    tables.add(join.table);
  }
  if (query.where) {
    const cond = query.where;
    tuples = tuples.filter((t) => passes(cond, t));
  }
  const rows = project(tuples, query);
  return sortRows(rows, query.select.map((s) => s.as));
}

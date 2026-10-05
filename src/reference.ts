/**
 * Reference interpreter: deliberately simple and independent of the main
 * engine. Joins are always nested loops; grouping is a linear scan with
 * structural equality. Used to cross-check the main engine on tiny inputs.
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
  valuesEqual,
  type Database,
  type Row,
  type Value,
} from "./values.js";

function refAggregate(item: SelectAgg, tuples: Tuple[]): Value {
  if (item.func === "count") {
    if (item.arg === "*") return BigInt(tuples.length);
    let n = 0n;
    for (const t of tuples) {
      if (evalExpr(item.arg, t) !== null) n++;
    }
    return n;
  }
  const arg = item.arg as Expr;
  const vals: Value[] = [];
  for (const t of tuples) {
    const v = evalExpr(arg, t);
    if (v !== null) vals.push(v);
  }
  if (item.func === "min" || item.func === "max") {
    let best: Value = null;
    for (const v of vals) {
      if (best === null) best = v;
      else {
        const c = compareValues(v, best);
        if (item.func === "min" ? c < 0 : c > 0) best = v;
      }
    }
    return best;
  }
  // sum / avg
  let intSum = 0n;
  let floatSum = 0;
  let isFloat = false;
  for (const v of vals) {
    if (typeof v === "bigint" && !isFloat) {
      intSum += v;
    } else if (typeof v === "number" || typeof v === "bigint") {
      if (!isFloat) {
        floatSum = Number(intSum);
        isFloat = true;
      }
      floatSum += Number(v);
    } else {
      throw new QueryError(`aggregate "${item.func}" requires numbers`);
    }
  }
  if (vals.length === 0) return null;
  if (item.func === "sum") return isFloat ? floatSum : intSum;
  if (!isFloat) {
    const count = BigInt(vals.length);
    if (intSum % count === 0n) return intSum / count;
  }
  return (isFloat ? floatSum : Number(intSum)) / vals.length;
}

/** Execute a query with the reference nested-loop interpreter. */
export function runQueryReference(db: Database, query: Query): Row[] {
  const fromRows = db.tables[query.from];
  if (!fromRows) throw new QueryError(`unknown table "${query.from}"`);

  // FROM + INNER JOINs via nested loops, keeping only TRUE ON conditions.
  let tuples: Tuple[] = fromRows.map((rec) => [{ table: query.from, rec }]);
  for (const join of query.joins) {
    const rightRows = db.tables[join.table];
    if (!rightRows) throw new QueryError(`unknown table "${join.table}"`);
    const next: Tuple[] = [];
    for (const lt of tuples) {
      for (const r of rightRows) {
        const joined: Tuple = [...lt, { table: join.table, rec: r }];
        if (passes(join.on, joined)) next.push(joined);
      }
    }
    tuples = next;
  }

  // WHERE keeps only TRUE.
  if (query.where) {
    const cond = query.where;
    const kept: Tuple[] = [];
    for (const t of tuples) {
      if (passes(cond, t)) kept.push(t);
    }
    tuples = kept;
  }

  const hasAgg = query.select.some((s) => s.kind === "agg");
  const out: Row[] = [];

  if (query.groupBy.length === 0 && !hasAgg) {
    for (const t of tuples) {
      const row: Row = {};
      for (const item of query.select) {
        if (item.kind === "col") row[item.as] = resolveColumn(t, item.name);
      }
      out.push(row);
    }
  } else {
    // Linear-scan grouping with structural key equality.
    const groups: { keyVals: Value[]; tuples: Tuple[] }[] = [];
    if (query.groupBy.length === 0) {
      groups.push({ keyVals: [], tuples: [...tuples] });
    } else {
      for (const t of tuples) {
        const keyVals = query.groupBy.map((c) => resolveColumn(t, c));
        let g = groups.find((g) =>
          g.keyVals.every((kv, i) => valuesEqual(kv, keyVals[i] as Value)),
        );
        if (!g) {
          g = { keyVals, tuples: [] };
          groups.push(g);
        }
        g.tuples.push(t);
      }
    }
    for (const g of groups) {
      const row: Row = {};
      for (const item of query.select) {
        if (item.kind === "col") {
          const idx = query.groupBy.indexOf(item.name);
          row[item.as] = g.keyVals[idx] as Value;
        } else {
          row[item.as] = refAggregate(item, g.tuples);
        }
      }
      out.push(row);
    }
  }

  // Deterministic sort by all output columns.
  const columns = query.select.map((s) => s.as);
  out.sort((a, b) => {
    for (const col of columns) {
      const c = compareValues(a[col] as Value, b[col] as Value);
      if (c !== 0) return c;
    }
    return 0;
  });
  return out;
}

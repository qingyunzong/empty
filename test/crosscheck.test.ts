/**
 * Cross-check: the main engine (hash join / hash grouping) must produce
 * exactly the same output as the independent nested-loop reference
 * interpreter on randomly generated tiny tables and queries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runQuery } from "../src/engine.js";
import { runQueryReference } from "../src/reference.js";
import { parseQuery, type Query } from "../src/query.js";
import { stringifyRows, type Database, type Row, type Value } from "../src/values.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  private rnd: () => number;
  constructor(seed: number) {
    this.rnd = mulberry32(seed);
  }
  int(n: number): number {
    return Math.floor(this.rnd() * n);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)] as T;
  }
  chance(p: number): boolean {
    return this.rnd() < p;
  }
}

const NUM_DOMAIN: readonly Value[] = [null, 0n, 1n, 2n, 3n, 0.5];
const STR_DOMAIN: readonly Value[] = [null, "p", "q"];

function randomTable(g: Gen, numericCols: string[], strCols: string[]): Row[] {
  const n = g.int(5); // 0..4 rows
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const row: Row = {};
    for (const c of numericCols) row[c] = g.pick(NUM_DOMAIN);
    for (const c of strCols) row[c] = g.pick(STR_DOMAIN);
    rows.push(row);
  }
  return rows;
}

type JExpr = Record<string, unknown>;

function randomPredicate(g: Gen, cols: string[]): JExpr {
  const litPool: unknown[] = [null, 0, 1, 2, 3, "p", "q", 0.5];
  const leaf = (): JExpr => {
    if (g.chance(0.15)) {
      return { op: "isnull", arg: { col: g.pick(cols) } };
    }
    const op = g.pick(["=", "<>", "<", "<=", ">", ">="] as const);
    const useTwoCols = g.chance(0.3);
    return {
      op,
      left: { col: g.pick(cols) },
      right: useTwoCols ? { col: g.pick(cols) } : { lit: g.pick(litPool) },
    };
  };
  const depth1 = (): JExpr => {
    if (g.chance(0.25)) return { op: "not", arg: leaf() };
    if (g.chance(0.4)) {
      return { op: g.pick(["and", "or"] as const), args: [leaf(), leaf()] };
    }
    return leaf();
  };
  if (g.chance(0.3)) {
    return { op: g.pick(["and", "or"] as const), args: [depth1(), depth1()] };
  }
  return depth1();
}

function randomQuery(g: Gen, joined: boolean): unknown {
  const aCols = ["a.id", "a.x", "a.g"];
  const allCols = joined ? [...aCols, "b.id", "b.y", "b.g"] : aCols;

  const query: Record<string, unknown> = { from: "a" };
  if (joined) {
    const style = g.int(4);
    let on: JExpr;
    if (style === 0) {
      on = { op: "=", left: { col: "a.id" }, right: { col: "b.id" } };
    } else if (style === 1) {
      on = {
        op: "and",
        args: [
          { op: "=", left: { col: "a.id" }, right: { col: "b.id" } },
          { op: "=", left: { col: "a.g" }, right: { col: "b.g" } },
        ],
      };
    } else if (style === 2) {
      on = {
        op: "and",
        args: [
          { op: "=", left: { col: "a.x" }, right: { col: "b.y" } },
          { op: g.pick(["<", "<=", ">", ">="] as const), left: { col: "a.id" }, right: { col: "b.id" } },
        ],
      };
    } else {
      on = { op: g.pick(["<", "<=", ">", ">=", "<>"] as const), left: { col: "a.x" }, right: { col: "b.y" } };
    }
    query.joins = [{ table: "b", on }];
  }
  if (g.chance(0.7)) {
    query.where = randomPredicate(g, allCols);
  }

  const useGroup = g.chance(0.6);
  const select: unknown[] = [];
  if (useGroup) {
    const groupable = ["a.g", "a.id", ...(joined ? ["b.g", "b.id"] : [])];
    const groupBy: string[] = [];
    if (g.chance(0.8)) groupBy.push(g.pick(groupable));
    if (g.chance(0.25)) {
      const second = g.pick(groupable);
      if (!groupBy.includes(second)) groupBy.push(second);
    }
    query.groupBy = groupBy;
    groupBy.forEach((c, i) => select.push({ col: c, as: `k${i}` }));
    const numCols = joined ? ["a.id", "a.x", "b.id", "b.y"] : ["a.id", "a.x"];
    const aggs: unknown[] = [{ agg: "count", arg: "*", as: "n" }];
    const extra = 1 + g.int(3);
    for (let i = 0; i < extra; i++) {
      const func = g.pick(["count", "sum", "avg", "min", "max"] as const);
      aggs.push({ agg: func, arg: { col: g.pick(numCols) }, as: `agg${i}` });
    }
    select.push(...aggs);
  } else {
    const n = 1 + g.int(3);
    const chosen = new Set<string>();
    for (let i = 0; i < n; i++) chosen.add(g.pick(allCols));
    let i = 0;
    for (const c of chosen) select.push({ col: c, as: `c${i++}` });
  }
  query.select = select;
  return query;
}

test("cross-check main engine vs nested-loop reference on tiny random inputs", () => {
  const ITERATIONS = 500;
  for (let seed = 1; seed <= ITERATIONS; seed++) {
    const g = new Gen(seed);
    const tableA = randomTable(g, ["id", "x"], ["g"]);
    const tableB = randomTable(g, ["id", "y"], ["g"]);
    const database: Database = { tables: { a: tableA, b: tableB } };
    const joined = g.chance(0.65);
    const query: Query = parseQuery(randomQuery(g, joined));

    let mainRows: Row[] | undefined;
    let mainErr: unknown;
    let refRows: Row[] | undefined;
    let refErr: unknown;
    try {
      mainRows = runQuery(database, query);
    } catch (e) {
      mainErr = e;
    }
    try {
      refRows = runQueryReference(database, query);
    } catch (e) {
      refErr = e;
    }
    const ctx = `seed=${seed} db=${stringifyRows(tableA)}/${stringifyRows(
      tableB,
    )} query=${JSON.stringify(query)}`;
    assert.equal(mainErr === undefined, refErr === undefined, `throw mismatch: ${ctx}`);
    if (mainRows && refRows) {
      assert.deepStrictEqual(mainRows, refRows, `result mismatch: ${ctx}`);
      // Determinism: re-running yields byte-identical serialization.
      assert.equal(
        stringifyRows(runQuery(database, query)),
        stringifyRows(mainRows),
        `non-deterministic output: ${ctx}`,
      );
    }
  }
});

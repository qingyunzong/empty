/**
 * Differential test: the main engine (pushdown + hash join + hash grouping)
 * must agree with the naive nested-loop reference on randomly generated
 * small tables and queries. Seeds are fixed for reproducibility.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runQuery } from "../src/engine.js";
import { runQueryReference } from "../src/reference.js";
import type { Expr, Query, SelectItem, TableInput } from "../src/types.js";

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

type Gen = ReturnType<typeof makeGen>;

function makeGen(seed: number) {
  const rand = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const int = (n: number): number => Math.floor(rand() * n);
  const chance = (p: number): boolean => rand() < p;
  return { rand, pick, int, chance };
}

const INT_VALS = [0, 1, 2, 3, 5];
const STR_VALS = ["a", "b", "c"];
const FLOAT_VALS = [0.5, 1.5, 2.5];

function randomValue(g: Gen, kind: "int" | "str" | "float"): unknown {
  if (g.chance(0.25)) return null;
  if (kind === "int") return g.pick(INT_VALS);
  if (kind === "str") return g.pick(STR_VALS);
  return g.pick(FLOAT_VALS);
}

function randomTables(g: Gen): Record<string, TableInput> {
  const tables: Record<string, TableInput> = {};
  for (const name of ["t1", "t2", "t3"]) {
    const rows: Record<string, unknown>[] = [];
    const n = g.int(7);
    for (let i = 0; i < n; i++) {
      rows.push({
        id: randomValue(g, "int"),
        x: randomValue(g, "int"),
        f: randomValue(g, "float"),
        tag: randomValue(g, "str"),
      });
    }
    tables[name] = { columns: ["id", "x", "f", "tag"], rows };
  }
  return tables;
}

function randomPred(g: Gen, aliases: string[], depth: number): Expr {
  const intCol = () => ({ col: `${g.pick(aliases)}.${g.pick(["id", "x"])}` });
  const floatCol = () => ({ col: `${g.pick(aliases)}.f` });
  const strCol = () => ({ col: `${g.pick(aliases)}.tag` });
  if (depth > 0 && g.chance(0.35)) {
    const op = g.pick(["and", "or"] as const);
    return { op, args: [randomPred(g, aliases, depth - 1), randomPred(g, aliases, depth - 1)] };
  }
  if (depth > 0 && g.chance(0.15)) {
    return { op: "not", arg: randomPred(g, aliases, depth - 1) };
  }
  if (g.chance(0.15)) {
    const c = g.chance(0.5) ? intCol() : strCol();
    return { op: g.chance(0.5) ? "isNull" : "isNotNull", arg: c };
  }
  const kind = g.pick(["int", "float", "str"] as const);
  const col = kind === "int" ? intCol() : kind === "float" ? floatCol() : strCol();
  const other =
    g.chance(0.5)
      ? kind === "int"
        ? intCol()
        : kind === "float"
          ? floatCol()
          : strCol()
      : { lit: randomValue(g, kind) };
  const op = g.pick(["eq", "ne", "lt", "le", "gt", "ge"] as const);
  return { op, args: [col, other] };
}

function randomQuery(g: Gen): Query {
  const tableNames = ["t1", "t2", "t3"];
  const from = g.pick(tableNames);
  const aliases = ["a"];
  const joins: NonNullable<Query["joins"]> = [];
  const remaining = tableNames.filter((t) => t !== from);
  const nJoins = g.int(3);
  for (let i = 0; i < nJoins; i++) {
    const alias = String.fromCharCode(98 + i); // b, c
    const table = remaining[i % remaining.length]!;
    aliases.push(alias);
    const left = g.pick(aliases.slice(0, -1));
    const eqConj: Expr = {
      op: "eq",
      args: [{ col: `${left}.${g.pick(["id", "x"])}` }, { col: `${alias}.${g.pick(["id", "x"])}` }],
    };
    const on: Expr = g.chance(0.7)
      ? eqConj
      : { op: "and", args: [eqConj, randomPred(g, [...aliases], 1)] };
    joins.push({ table, as: alias, on });
  }

  const where: Expr | undefined = g.chance(0.7) ? randomPred(g, aliases, 2) : undefined;

  const groupable = aliases.flatMap((a) => [`${a}.id`, `${a}.x`, `${a}.tag`]);
  const useGroup = g.chance(0.6);
  const groupBy = useGroup
    ? [...new Set([g.pick(groupable), ...(g.chance(0.4) ? [g.pick(groupable)] : [])])]
    : [];
  const select: SelectItem[] = groupBy.map((col) => ({ col }));
  const aggCols = aliases.flatMap((a) => [`${a}.id`, `${a}.x`, `${a}.f`]);
  const nAggs = useGroup ? 1 + g.int(3) : g.chance(0.5) ? 1 + g.int(2) : 0;
  for (let i = 0; i < nAggs; i++) {
    const fn = g.pick(["count", "sum", "min", "max", "avg"] as const);
    const arg = fn === "count" && g.chance(0.4) ? "*" : g.pick(aggCols);
    select.push({ agg: { fn, arg }, as: `${fn}${i}` });
  }
  if (select.length === 0) {
    select.push({ col: `${aliases[0]}.id` }, { col: `${aliases[0]}.tag` });
  }
  const query: Query = { from: { table: from, as: "a" }, select };
  if (joins.length > 0) query.joins = joins;
  if (where) query.where = where;
  if (groupBy.length > 0) query.groupBy = groupBy;
  return query;
}

test("engine matches nested-loop reference on random small inputs", () => {
  const CASES = 2000;
  for (let seed = 1; seed <= CASES; seed++) {
    const g = makeGen(seed);
    const tables = randomTables(g);
    const query = randomQuery(g);
    const expected = runQueryReference(query, tables);
    const actual = runQuery(query, tables);
    assert.deepEqual(
      actual,
      expected,
      `mismatch at seed ${seed}: ${JSON.stringify(query)}`,
    );
  }
});

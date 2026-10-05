import { test } from "node:test";
import assert from "node:assert/strict";

import { runQuery } from "../src/engine.js";
import { runQueryReference } from "../src/reference.js";
import { parseQuery } from "../src/query.js";
import {
  parseDatabase,
  parseJson,
  stringifyRows,
  type Database,
} from "../src/values.js";

function db(text: string): Database {
  return parseDatabase(text);
}

function q(node: unknown) {
  return parseQuery(node);
}

test("projection and filter: WHERE keeps only TRUE", () => {
  const database = db(`{"tables":{"users":[
    {"id":1,"name":"amy","age":30},
    {"id":2,"name":"bob","age":null},
    {"id":3,"name":"cy","age":17}
  ]}}`);
  const query = q({
    from: "users",
    where: { op: ">=", left: { col: "age" }, right: { lit: 18 } },
    select: [{ col: "id" }, { col: "name" }],
  });
  // age NULL -> UNKNOWN -> dropped; 17 >= 18 -> FALSE -> dropped.
  assert.deepStrictEqual(runQuery(database, query), [
    { id: 1n, name: "amy" },
  ]);
});

test("NULL comparison is UNKNOWN; IS NULL recovers those rows", () => {
  const database = db(`{"tables":{"t":[{"x":1},{"x":null},{"x":2}]}}`);
  const eqNull = q({
    from: "t",
    where: { op: "=", left: { col: "x" }, right: { lit: null } },
    select: [{ col: "x" }],
  });
  assert.deepStrictEqual(runQuery(database, eqNull), []);
  const isNull = q({
    from: "t",
    where: { op: "isnull", arg: { col: "x" } },
    select: [{ col: "x" }],
  });
  assert.deepStrictEqual(runQuery(database, isNull), [{ x: null }]);
  const neq = q({
    from: "t",
    where: { op: "<>", left: { col: "x" }, right: { lit: 1 } },
    select: [{ col: "x" }],
  });
  // NULL <> 1 is UNKNOWN, so only x = 2 survives.
  assert.deepStrictEqual(runQuery(database, neq), [{ x: 2n }]);
});

test("three-valued AND / OR / NOT", () => {
  const database = db(`{"tables":{"t":[{"x":null},{"x":1},{"x":2}]}}`);
  const notEq1 = q({
    from: "t",
    where: { op: "not", arg: { op: "=", left: { col: "x" }, right: { lit: 1 } } },
    select: [{ col: "x" }],
  });
  // NOT UNKNOWN = UNKNOWN (dropped); NOT TRUE = FALSE; NOT FALSE = TRUE.
  assert.deepStrictEqual(runQuery(database, notEq1), [{ x: 2n }]);

  const orUnknown = q({
    from: "t",
    where: {
      op: "or",
      args: [
        { op: "=", left: { col: "x" }, right: { lit: 1 } },
        { op: "=", left: { col: "x" }, right: { lit: 9 } },
      ],
    },
    select: [{ col: "x" }],
  });
  // UNKNOWN OR FALSE = UNKNOWN (dropped); TRUE kept.
  assert.deepStrictEqual(runQuery(database, orUnknown), [{ x: 1n }]);

  const andUnknown = q({
    from: "t",
    where: {
      op: "and",
      args: [
        { op: ">", left: { col: "x" }, right: { lit: 0 } },
        { op: "<", left: { col: "x" }, right: { lit: 2 } },
      ],
    },
    select: [{ col: "x" }],
  });
  assert.deepStrictEqual(runQuery(database, andUnknown), [{ x: 1n }]);
});

test("inner join drops NULL join keys", () => {
  const database = db(`{"tables":{
    "u":[{"id":1},{"id":2},{"id":null}],
    "o":[{"uid":1},{"uid":1},{"uid":null},{"uid":3}]
  }}`);
  const query = q({
    from: "u",
    joins: [{ table: "o", on: { op: "=", left: { col: "u.id" }, right: { col: "o.uid" } } }],
    select: [{ col: "u.id", as: "id" }, { col: "o.uid", as: "uid" }],
  });
  // NULL never equals NULL; only id = 1 matches, twice.
  assert.deepStrictEqual(runQuery(database, query), [
    { id: 1n, uid: 1n },
    { id: 1n, uid: 1n },
  ]);
});

test("COUNT(column) ignores NULLs; SUM/AVG/MIN/MAX ignore NULLs", () => {
  const database = db(`{"tables":{"e":[
    {"dept":"a","sal":100},
    {"dept":"a","sal":null},
    {"dept":"a","sal":300},
    {"dept":"b","sal":null},
    {"dept":null,"sal":7}
  ]}}`);
  const query = q({
    from: "e",
    groupBy: ["dept"],
    select: [
      { col: "dept" },
      { agg: "count", arg: "*", as: "n" },
      { agg: "count", arg: { col: "sal" }, as: "nsal" },
      { agg: "sum", arg: { col: "sal" }, as: "total" },
      { agg: "avg", arg: { col: "sal" }, as: "mean" },
      { agg: "min", arg: { col: "sal" }, as: "lo" },
      { agg: "max", arg: { col: "sal" }, as: "hi" },
    ],
  });
  assert.deepStrictEqual(runQuery(database, query), [
    // NULL dept keys group together; sorted with NULL first.
    { dept: null, n: 1n, nsal: 1n, total: 7n, mean: 7n, lo: 7n, hi: 7n },
    { dept: "a", n: 3n, nsal: 2n, total: 400n, mean: 200n, lo: 100n, hi: 300n },
    { dept: "b", n: 1n, nsal: 0n, total: null, mean: null, lo: null, hi: null },
  ]);
});

test("aggregates over the empty set: COUNT = 0, others NULL", () => {
  const database = db(`{"tables":{"t":[{"x":1}]}}`);
  const query = q({
    from: "t",
    where: { op: "=", left: { col: "x" }, right: { lit: 99 } },
    select: [
      { agg: "count", arg: "*", as: "n" },
      { agg: "count", arg: { col: "x" }, as: "nx" },
      { agg: "sum", arg: { col: "x" }, as: "s" },
      { agg: "avg", arg: { col: "x" }, as: "a" },
      { agg: "min", arg: { col: "x" }, as: "lo" },
      { agg: "max", arg: { col: "x" }, as: "hi" },
    ],
  });
  assert.deepStrictEqual(runQuery(database, query), [
    { n: 0n, nx: 0n, s: null, a: null, lo: null, hi: null },
  ]);
});

test("integers are exact beyond 2^53 (BigInt end to end)", () => {
  const database = db(`{"tables":{"t":[
    {"g":"k","v":9007199254740993},
    {"g":"k","v":9007199254740993}
  ]}}`);
  const query = q({
    from: "t",
    groupBy: ["g"],
    select: [
      { col: "g" },
      { agg: "sum", arg: { col: "v" }, as: "s" },
    ],
  });
  const rows = runQuery(database, query);
  assert.deepStrictEqual(rows, [{ g: "k", s: 18014398509481986n }]);
  // Too large for a safe JSON number, so it serializes as a string.
  assert.equal(stringifyRows(rows), `[
  {
    "g": "k",
    "s": "18014398509481986"
  }
]`);
});

test("JSON parsing: integer literals become bigint, floats stay floats", () => {
  assert.equal(parseJson("9007199254740993"), 9007199254740993n);
  assert.equal(parseJson("1.5"), 1.5);
  assert.equal(parseJson("-4"), -4n);
  const database = db(`{"tables":{"t":[{"v":0.5},{"v":0.5},{"v":null}]}}`);
  const query = q({
    from: "t",
    select: [
      { agg: "sum", arg: { col: "v" }, as: "s" },
      { agg: "avg", arg: { col: "v" }, as: "a" },
    ],
  });
  assert.deepStrictEqual(runQuery(database, query), [{ s: 1, a: 0.5 }]);
});

test("AVG is exact when the integer quotient is integral", () => {
  const database = db(`{"tables":{"t":[
    {"g":"a","v":9007199254740993},
    {"g":"b","v":1},
    {"g":"b","v":2}
  ]}}`);
  const query = q({
    from: "t",
    groupBy: ["g"],
    select: [{ col: "g" }, { agg: "avg", arg: { col: "v" }, as: "a" }],
  });
  assert.deepStrictEqual(runQuery(database, query), [
    { g: "a", a: 9007199254740993n },
    { g: "b", a: 1.5 },
  ]);
});

test("output order is deterministic regardless of input row order", () => {
  const mk = (rows: string) => db(`{"tables":{"t":${rows}}}`);
  const query = q({
    from: "t",
    select: [{ col: "a" }, { col: "b" }],
  });
  const base = mk(`[{"a":2,"b":"y"},{"a":null,"b":"z"},{"a":1,"b":null},{"a":1,"b":"a"}]`);
  const shuffled = mk(`[{"a":1,"b":"a"},{"a":2,"b":"y"},{"a":1,"b":null},{"a":null,"b":"z"}]`);
  const expected = [
    { a: null, b: "z" },
    { a: 1n, b: null },
    { a: 1n, b: "a" },
    { a: 2n, b: "y" },
  ];
  assert.deepStrictEqual(runQuery(base, query), expected);
  assert.deepStrictEqual(runQuery(shuffled, query), expected);
  assert.equal(stringifyRows(runQuery(base, query)), stringifyRows(runQuery(shuffled, query)));
});

test("arithmetic in expressions, with NULL propagation", () => {
  const database = db(`{"tables":{"t":[{"x":1},{"x":2},{"x":null}]}}`);
  const query = q({
    from: "t",
    where: { op: "=", left: { op: "+", left: { col: "x" }, right: { lit: 1 } }, right: { lit: 3 } },
    select: [{ col: "x" }],
  });
  assert.deepStrictEqual(runQuery(database, query), [{ x: 2n }]);
});

test("main engine and reference interpreter agree on directed cases", () => {
  const database = db(`{"tables":{
    "u":[{"id":1,"g":"x"},{"id":2,"g":"y"},{"id":null,"g":"x"}],
    "o":[{"uid":1,"amt":5},{"uid":2,"amt":null},{"uid":null,"amt":9}]
  }}`);
  const query = q({
    from: "u",
    joins: [{ table: "o", on: { op: "=", left: { col: "u.id" }, right: { col: "o.uid" } } }],
    groupBy: ["u.g"],
    select: [
      { col: "u.g", as: "g" },
      { agg: "count", arg: "*", as: "n" },
      { agg: "sum", arg: { col: "o.amt" }, as: "s" },
    ],
  });
  assert.deepStrictEqual(runQuery(database, query), runQueryReference(database, query));
});

test("errors: unknown table, ambiguous column, non-grouped select", () => {
  const database = db(`{"tables":{"a":[{"x":1}],"b":[{"x":1}]}}`);
  assert.throws(
    () => runQuery(database, q({ from: "nope", select: [{ col: "x" }] })),
    /unknown table/,
  );
  assert.throws(
    () =>
      runQuery(
        database,
        q({
          from: "a",
          joins: [{ table: "b", on: { op: "=", left: { col: "a.x" }, right: { col: "b.x" } } }],
          select: [{ col: "x" }],
        }),
      ),
    /ambiguous column/,
  );
  assert.throws(
    () =>
      q({
        from: "a",
        groupBy: ["x"],
        select: [{ col: "x" }, { col: "y" }],
      }),
    /must appear in "groupBy"/,
  );
});

import { test } from "node:test";
import assert from "node:assert";
import {
  table, scan, filter, project, join, execute, multisetEqual,
  eq, col, lit, gt, isNull,
} from "../src/index.js";

const R = table(["a", "b"], [[1, 10], [2, null], [null, 30], [2, null]]); // duplicate row kept
const S = table(["c", "d"], [[1, 100], [null, 200], [3, 300]]);

test("bag semantics: duplicates preserved through scan/filter/project", () => {
  const r = execute(project(["a", "b"], scan(R)));
  assert.equal(r.rows.length, 4); // the two (2,NULL) rows both survive
  const f = execute(filter(isNull(col("b")), scan(R)));
  assert.equal(f.rows.length, 2); // both duplicate NULL rows
});

test("filter keeps only TRUE (UNKNOWN rows dropped)", () => {
  const r = execute(filter(gt(col("a"), lit(1)), scan(R)));
  assert.equal(r.rows.length, 2); // a=2 twice; a=NULL row dropped (UNKNOWN)
});

test("inner join: NULL keys never match", () => {
  const r = execute(join("inner", eq(col("a"), col("c")), scan(R), scan(S)));
  assert.equal(r.rows.length, 1); // only a=1,c=1
  assert.equal(r.rows[0]!["d"], 100);
});

test("left join preserves unmatched left rows with NULLs", () => {
  const r = execute(join("left", eq(col("a"), col("c")), scan(R), scan(S)));
  assert.equal(r.rows.length, 4); // 1 matched + 3 preserved (incl. both duplicates)
  const nulls = r.rows.filter((row) => row["d"] === null);
  assert.equal(nulls.length, 3);
});

test("full join preserves both sides", () => {
  const r = execute(join("full", eq(col("a"), col("c")), scan(R), scan(S)));
  assert.equal(r.rows.length, 4 + 2); // left-preserved 4 + unmatched right (NULL,3)
});

test("multisetEqual is duplicate- and order-sensitive in the right way", () => {
  const t1 = { schema: ["x"], rows: [{ x: 1 }, { x: 1 }, { x: 2 }] };
  const t2 = { schema: ["x"], rows: [{ x: 2 }, { x: 1 }, { x: 1 }] };
  const t3 = { schema: ["x"], rows: [{ x: 1 }, { x: 2 }] };
  assert.ok(multisetEqual(t1, t2));
  assert.ok(!multisetEqual(t1, t3)); // duplicate multiplicity differs
});

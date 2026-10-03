"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tmpdir, writeRun, csv, cli } = require("./helpers");
const { buildSnapshot } = require("../src/snapshot");
const { diffSnapshots } = require("../src/diff");

function snaps(a, b) {
  return [buildSnapshot(a), buildSnapshot(b)];
}

test("symmetric diff: only_a / only_b / changed rows by primary key", () => {
  const schema = { tables: { t: { key: ["id"], types: { id: "string" } } } };
  const a = writeRun(tmpdir(), {
    params: {},
    schema,
    data: { t: csv(["id", "v"], [["1", "x"], ["2", "y"], ["3", "z"]]) },
  });
  const b = writeRun(tmpdir(), {
    params: {},
    schema,
    data: { t: csv(["id", "v"], [["2", "y"], ["3", "w"], ["4", "q"]]) },
  });
  const diff = diffSnapshots(...snaps(a, b));
  assert.equal(diff.status, "different");
  assert.deepEqual(diff.tables.t.only_a, [["1"]]);
  assert.deepEqual(diff.tables.t.only_b, [["4"]]);
  assert.equal(diff.tables.t.changed.length, 1);
  assert.deepEqual(diff.tables.t.changed[0].key, ["3"]);
  assert.deepEqual(diff.tables.t.changed[0].cells.v, { a: "z", b: "w", verdict: "different" });
});

test("float boundary: |a-b| == abs tolerance is equal, one ulp more is different", () => {
  const tol = Math.pow(2, -26);
  const schema = { tables: { t: { key: ["id"], tolerance: { v: { abs: tol } } } } };
  const mk = (v) =>
    writeRun(tmpdir(), { params: {}, schema, data: { t: csv(["id", "v"], [["1", String(v)]]) } });
  const base = mk(1);
  const atBoundary = mk(1 + tol);
  const pastBoundary = mk(1 + 2 * tol);
  assert.equal(diffSnapshots(...snaps(base, atBoundary)).status, "equal");
  const d2 = diffSnapshots(...snaps(base, pastBoundary));
  assert.equal(d2.status, "different");
  assert.equal(d2.tables.t.changed[0].cells.v.verdict, "different");
});

test("numeric mismatch without tolerance is undecided, not inconsistent", () => {
  const schema = { tables: { t: { key: ["id"] } } };
  const a = writeRun(tmpdir(), { params: {}, schema, data: { t: "id,v\n1,0.1\n" } });
  const b = writeRun(tmpdir(), { params: {}, schema, data: { t: "id,v\n1,0.1000000001\n" } });
  const diff = diffSnapshots(...snaps(a, b));
  assert.equal(diff.status, "undecided");
  assert.equal(diff.tables.t.changed.length, 0);
  assert.equal(diff.tables.t.undecided.length, 1);
  assert.equal(diff.tables.t.undecided[0].cells.v.verdict, "undecided");
  // CLI: undecided is not an inconsistency -> exit code 0
  const r = cli(["diff", a, b]);
  assert.equal(r.status, 0);
  assert.equal(r.json().status, "undecided");
});

test("NULL vs NULL is equal; NULL vs value is different", () => {
  const schema = { tables: { t: { key: ["id"], types: { id: "string" } } } };
  const a = writeRun(tmpdir(), { params: {}, schema, data: { t: "id,v\n1,\\N\n2,x\n" } });
  const b = writeRun(tmpdir(), { params: {}, schema, data: { t: "id,v\n1,\\N\n2,\\N\n" } });
  const diff = diffSnapshots(...snaps(a, b));
  assert.equal(diff.tables.t.changed.length, 1);
  assert.deepEqual(diff.tables.t.changed[0].key, ["2"]);
  assert.deepEqual(diff.tables.t.changed[0].cells.v, { a: "x", b: null, verdict: "different" });
});

test("missing column is distinct from NULL in diff output", () => {
  const schema = { tables: { t: { key: ["id"] } } };
  const a = writeRun(tmpdir(), { params: {}, schema, data: { t: "id,v\n1,x\n" } });
  const b = writeRun(tmpdir(), { params: {}, schema, data: { t: "id,v,w\n1,x,9\n" } });
  const diff = diffSnapshots(...snaps(a, b));
  assert.equal(diff.tables.t.changed.length, 1);
  const cell = diff.tables.t.changed[0].cells.w;
  assert.deepEqual(cell.a, { $missing: true });
  assert.equal(cell.b, 9);
  assert.equal(cell.verdict, "different");
});

test("conflicting tolerances between snapshots raise E_TOL (exit 11)", () => {
  const a = writeRun(tmpdir(), {
    params: {},
    schema: { tables: { t: { key: ["id"], tolerance: { v: 1e-9 } } } },
    data: { t: "id,v\n1,1\n" },
  });
  const b = writeRun(tmpdir(), {
    params: {},
    schema: { tables: { t: { key: ["id"], tolerance: { v: 1e-6 } } } },
    data: { t: "id,v\n1,1\n" },
  });
  const r = cli(["diff", a, b]);
  assert.equal(r.status, 11);
  assert.match(r.stderr, /E_TOL/);
});

test("param diff distinguishes missing key from explicit null", () => {
  const a = writeRun(tmpdir(), { params: { x: null, y: 1 }, schema: { tables: {} }, data: {} });
  const b = writeRun(tmpdir(), { params: { y: 1 }, schema: { tables: {} }, data: {} });
  const diff = diffSnapshots(...snaps(a, b));
  assert.equal(diff.params.changed.length, 1);
  assert.equal(diff.params.changed[0].path, "x");
  assert.deepEqual(diff.params.changed[0].a, null);
  assert.deepEqual(diff.params.changed[0].b, { $missing: true });
  assert.equal(diff.params.changed[0].kind, "only_a");
});

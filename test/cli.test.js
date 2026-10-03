"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir, writeRun, csv, cli } = require("./helpers");

const schema = { tables: { t: { key: ["id"] } } };

function run(dir, v) {
  return writeRun(dir, {
    params: { lr: 0.1 },
    schema,
    data: { t: csv(["id", "v"], [["1", v]]) },
  });
}

test("snap writes snapshot and index; diff exit codes reflect status", () => {
  const a = run(tmpdir(), "x");
  const b = run(tmpdir(), "y");
  const c = run(tmpdir(), "x");
  const s = cli(["snap", a]);
  assert.equal(s.status, 0);
  assert.ok(fs.existsSync(path.join(a, ".snap", "snapshot.json")));
  assert.ok(fs.existsSync(path.join(a, ".snap", "index.json")));
  assert.equal(s.json().tables.t.rows, 1);
  const different = cli(["diff", a, b]);
  assert.equal(different.status, 1);
  assert.equal(different.json().status, "different");
  const equal = cli(["diff", a, c]);
  assert.equal(equal.status, 0);
  assert.equal(equal.json().status, "equal");
});

test("minexplain exits 0 on a unique minimal explanation", () => {
  const sch = { tables: { t: { key: ["id"] } }, deps: { lr: ["t"] } };
  const a = writeRun(tmpdir(), { params: { lr: 1 }, schema: sch, data: { t: "id,v\n1,x\n" } });
  const b = writeRun(tmpdir(), { params: { lr: 2 }, schema: sch, data: { t: "id,v\n1,y\n" } });
  const r = cli(["minexplain", a, b]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json().explanations, [["lr"]]);
});

test("E_NO_KEY (exit 10) when a table has no primary key", () => {
  const dir = writeRun(tmpdir(), {
    params: {},
    schema: { tables: { t: {} } },
    data: { t: "id,v\n1,x\n" },
  });
  const r = cli(["snap", dir]);
  assert.equal(r.status, 10);
  assert.match(r.stderr, /E_NO_KEY/);
});

test("E_TOL (exit 11) on invalid tolerance spec", () => {
  const dir = writeRun(tmpdir(), {
    params: {},
    schema: { tables: { t: { key: ["id"], tolerance: { v: "wide" } } } },
    data: { t: "id,v\n1,2\n" },
  });
  const r = cli(["snap", dir]);
  assert.equal(r.status, 11);
  assert.match(r.stderr, /E_TOL/);
});

test("E_SNAP (exit 13) on missing params.json and on corrupt snapshot", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const r1 = cli(["snap", dir]);
  assert.equal(r1.status, 13);
  assert.match(r1.stderr, /E_SNAP/);

  const good = run(tmpdir(), "x");
  const bad = run(tmpdir(), "x");
  cli(["snap", bad]);
  fs.writeFileSync(path.join(bad, ".snap", "snapshot.json"), "{not json");
  const r2 = cli(["diff", good, bad]);
  assert.equal(r2.status, 13);
  assert.match(r2.stderr, /E_SNAP/);
});

test("unknown command prints usage with exit 2", () => {
  const r = cli(["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

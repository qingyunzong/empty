"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tmpdir, writeRun, csv } = require("./helpers");
const { buildSnapshot } = require("../src/snapshot");

const schema = {
  tables: { metrics: { key: ["id"], tolerance: { loss: 1e-9 } } },
};

test("row order in CSV does not affect the normalized snapshot hash", () => {
  const a = writeRun(tmpdir(), {
    params: { lr: 0.1 },
    schema,
    data: { metrics: csv(["id", "loss"], [["1", "0.5"], ["2", "0.6"], ["3", "0.7"]]) },
  });
  const b = writeRun(tmpdir(), {
    params: { lr: 0.1 },
    schema,
    data: { metrics: csv(["id", "loss"], [["3", "0.7"], ["1", "0.5"], ["2", "0.6"]]) },
  });
  assert.equal(buildSnapshot(a).tables.metrics.hash, buildSnapshot(b).tables.metrics.hash);
});

test("floats are canonicalized and quantized by abs tolerance in row hashes", () => {
  const a = writeRun(tmpdir(), {
    params: {},
    schema,
    data: { metrics: csv(["id", "loss"], [["1", "0.30000000000000004"]]) },
  });
  const b = writeRun(tmpdir(), {
    params: {},
    schema,
    data: { metrics: csv(["id", "loss"], [["1", "0.3"]]) },
  });
  const sa = buildSnapshot(a);
  const sb = buildSnapshot(b);
  assert.equal(sa.tables.metrics.hash, sb.tables.metrics.hash);
  assert.deepEqual(sa.tables.metrics.rows["[1]"].cells.loss, 0.30000000000000004);
});

test("NULL literal and missing cell are distinct in the snapshot", () => {
  const dir = writeRun(tmpdir(), {
    params: {},
    schema: { tables: { t: { key: ["id"] } } },
    data: { t: "id,v,note\n1,\\N,x\n2,5\n" },
  });
  const snap = buildSnapshot(dir);
  const rows = snap.tables.t.rows;
  assert.equal(rows["[1]"].cells.v, null);
  assert.deepEqual(rows["[2]"].cells.note, { $missing: true });
  assert.notDeepEqual(rows["[1]"].cells.v, rows["[2]"].cells.note);
});

test("missing primary key declaration raises E_NO_KEY", () => {
  const dir = writeRun(tmpdir(), {
    params: {},
    schema: { tables: { t: {} } },
    data: { t: "id,v\n1,x\n" },
  });
  assert.throws(() => buildSnapshot(dir), /E_NO_KEY|primary key/);
  try {
    buildSnapshot(dir);
  } catch (err) {
    assert.equal(err.code, "E_NO_KEY");
  }
});

test("invalid tolerance raises E_TOL", () => {
  const dir = writeRun(tmpdir(), {
    params: {},
    schema: { tables: { t: { key: ["id"], tolerance: { v: -1 } } } },
    data: { t: "id,v\n1,2\n" },
  });
  try {
    buildSnapshot(dir);
    assert.fail("expected E_TOL");
  } catch (err) {
    assert.equal(err.code, "E_TOL");
  }
});

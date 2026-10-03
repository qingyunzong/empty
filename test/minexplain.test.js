"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tmpdir, writeRun, csv, cli } = require("./helpers");
const { buildSnapshot } = require("../src/snapshot");
const { diffSnapshots } = require("../src/diff");
const { minExplain } = require("../src/minexplain");

function explain(a, b) {
  const snapA = buildSnapshot(a);
  const snapB = buildSnapshot(b);
  return minExplain(diffSnapshots(snapA, snapB), snapA, snapB);
}

const norm = (sets) => sets.map((s) => [...s].sort()).sort();

test("unique minimal explanation excludes non-covering params", () => {
  const schema = {
    tables: {
      metrics: { key: ["id"], tolerance: { loss: 1e-9 } },
      samples: { key: ["id"] },
    },
    deps: { "optimizer.lr": ["metrics"], seed: ["samples"] },
  };
  const a = writeRun(tmpdir(), {
    params: { optimizer: { lr: 0.1 }, seed: 1, epochs: 10 },
    schema,
    data: {
      metrics: csv(["id", "loss"], [["1", "0.5"], ["2", "0.6"]]),
      samples: csv(["id", "label"], [["1", "a"]]),
    },
  });
  const b = writeRun(tmpdir(), {
    params: { optimizer: { lr: 0.2 }, seed: 2, epochs: 20 },
    schema,
    data: {
      metrics: csv(["id", "loss"], [["1", "0.9"], ["2", "0.6"]]),
      samples: csv(["id", "label"], [["1", "b"]]),
    },
  });
  const r = explain(a, b);
  assert.equal(r.exact, true);
  assert.deepEqual(norm(r.explanations), [["optimizer.lr", "seed"]]);
  assert.equal(r.explanationSize, 2);
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.unexplained, []);
});

test("tied minimal explanations are all listed and flagged ambiguous", () => {
  const schema = {
    tables: { metrics: { key: ["id"] } },
    deps: { p1: ["metrics"], p2: ["metrics"] },
  };
  const a = writeRun(tmpdir(), {
    params: { p1: 1, p2: 1 },
    schema,
    data: { metrics: csv(["id", "v"], [["1", "x"]]) },
  });
  const b = writeRun(tmpdir(), {
    params: { p1: 2, p2: 2 },
    schema,
    data: { metrics: csv(["id", "v"], [["1", "y"]]) },
  });
  const r = explain(a, b);
  assert.deepEqual(norm(r.explanations), [["p1"], ["p2"]]);
  assert.equal(r.ambiguous, true);
  // CLI surfaces the ambiguity as E_AMBIG_MIN (exit 12) while listing all minima
  const res = cli(["minexplain", a, b]);
  assert.equal(res.status, 12);
  assert.match(res.stderr, /E_AMBIG_MIN/);
  assert.deepEqual(norm(res.json().explanations), [["p1"], ["p2"]]);
});

test("200 differing rows: minimal explanation matches exhaustive subset search", () => {
  const ROWS = 200;
  const schema = {
    tables: {
      metrics: { key: ["id"] },
      samples: { key: ["id"] },
    },
    deps: { p1: ["metrics"], p2: ["metrics"], p3: ["samples"], p5: ["metrics"] },
  };
  const metricsA = csv(["id", "v"], Array.from({ length: ROWS }, (_, i) => [String(i), "a" + i]));
  const metricsB = csv(["id", "v"], Array.from({ length: ROWS }, (_, i) => [String(i), "b" + i]));
  const a = writeRun(tmpdir(), {
    params: { p1: 1, p2: 1, p3: 1, p4: 1, p5: 1 },
    schema,
    data: {
      metrics: metricsA,
      samples: csv(["id", "v"], [["s1", "x"], ["s2", "y"], ["s3", "z"]]),
    },
  });
  const b = writeRun(tmpdir(), {
    params: { p1: 2, p2: 2, p3: 2, p4: 2, p5: 2 },
    schema,
    data: {
      metrics: metricsB,
      samples: csv(["id", "v"], [["s1", "X"], ["s2", "Y"], ["s3", "Z"]]),
    },
  });
  const snapA = buildSnapshot(a);
  const snapB = buildSnapshot(b);
  const diff = diffSnapshots(snapA, snapB);
  const result = minExplain(diff, snapA, snapB);
  assert.equal(result.targetRows, ROWS + 3);
  assert.equal(result.exact, true);

  // Independent brute force over all 2^5 param subsets.
  const changedParams = ["p1", "p2", "p3", "p4", "p5"];
  const coverageOf = (p) => {
    const tables = schema.deps[p] || [];
    const ids = new Set();
    for (const t of tables) {
      for (const k of Object.keys(snapA.tables[t].rows)) ids.add(t + "|" + k);
      for (const k of Object.keys(snapB.tables[t].rows)) ids.add(t + "|" + k);
    }
    return ids;
  };
  const goal = [];
  for (const [t, r] of Object.entries(diff.tables)) {
    for (const k of [...r.only_a, ...r.only_b]) goal.push(t + "|" + JSON.stringify(k));
    for (const ch of r.changed) goal.push(t + "|" + JSON.stringify(ch.key));
  }
  const brute = [];
  for (let mask = 0; mask < 1 << changedParams.length; mask++) {
    const combo = changedParams.filter((_, i) => mask & (1 << i));
    const covered = new Set();
    for (const p of combo) for (const id of coverageOf(p)) covered.add(id);
    if (goal.every((id) => covered.has(id))) brute.push(combo);
  }
  const minSize = Math.min(...brute.map((c) => c.length));
  const expected = brute.filter((c) => c.length === minSize);
  assert.deepEqual(norm(result.explanations), norm(expected));
  assert.equal(minSize, 2);
  assert.equal(expected.length, 3); // {p1|p2|p5} x {p3}
});

test("foreign-key refs propagate coverage transitively", () => {
  const schema = {
    tables: {
      metrics: { key: ["id"] },
      preds: { key: ["pid"], refs: { metric_id: "metrics.id" } },
    },
    deps: { "optimizer.lr": ["metrics"] },
  };
  const a = writeRun(tmpdir(), {
    params: { optimizer: { lr: 0.1 } },
    schema,
    data: {
      metrics: csv(["id", "v"], [["m1", "1"], ["m2", "2"]]),
      preds: csv(["pid", "metric_id", "out"], [["p1", "m1", "x"], ["p2", "m2", "y"]]),
    },
  });
  const b = writeRun(tmpdir(), {
    params: { optimizer: { lr: 0.2 } },
    schema,
    data: {
      metrics: csv(["id", "v"], [["m1", "1"], ["m2", "2"]]),
      preds: csv(["pid", "metric_id", "out"], [["p1", "m1", "X"], ["p2", "m2", "y"]]),
    },
  });
  const r = explain(a, b);
  assert.deepEqual(norm(r.explanations), [["optimizer.lr"]]);
  assert.deepEqual(r.unexplained, []);
});

test("rows unreachable from any changed param are reported unexplained", () => {
  const schema = {
    tables: { metrics: { key: ["id"] } },
    deps: { lr: ["metrics"] },
  };
  const a = writeRun(tmpdir(), {
    params: { lr: 0.1 },
    schema,
    data: { metrics: csv(["id", "v"], [["1", "x"]]) },
  });
  const b = writeRun(tmpdir(), {
    params: { lr: 0.1 },
    schema,
    data: { metrics: csv(["id", "v"], [["1", "y"]]) },
  });
  const r = explain(a, b);
  assert.deepEqual(r.explanations, []);
  assert.equal(r.unexplained.length, 1);
});

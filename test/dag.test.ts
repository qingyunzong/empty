import test from "node:test";
import assert from "node:assert/strict";
import { DagEngine, evaluateDagModel } from "../src/dag";
import { mulberry32 } from "./helpers";

interface Counting {
  sum: number;
  prod: number;
}

function buildEngine(calls: Counting): DagEngine {
  const dag = new DagEngine();
  dag.addSource("s1", 2);
  dag.addSource("s2", 3);
  dag.addSource("flag", 1);
  dag.addNode("sum", {
    kind: "derived",
    deps: ["s1", "s2"],
    compute: (v) => {
      calls.sum++;
      return v[0] + v[1];
    },
  });
  dag.addNode("prod", {
    kind: "derived",
    deps: ["s1", "s2"],
    compute: (v) => {
      calls.prod++;
      return v[0] * v[1];
    },
  });
  dag.addNode("pick", {
    kind: "conditional",
    conditionDeps: ["flag"],
    select: (v) => (v[0] >= 0 ? "pos" : "neg"),
    branches: {
      pos: { deps: ["sum"], compute: (v) => v[0] * 10 },
      neg: { deps: ["prod"], compute: (v) => -v[0] },
    },
  });
  dag.addNode("out", { kind: "derived", deps: ["pick"], compute: (v) => v[0] + 1 });
  return dag;
}

test("conditional dependencies evaluate only the selected branch", () => {
  const calls: Counting = { sum: 0, prod: 0 };
  const dag = buildEngine(calls);

  assert.equal(dag.evaluate("out"), (2 + 3) * 10 + 1);
  assert.equal(calls.sum, 1);
  assert.equal(calls.prod, 0, "unselected branch must not be evaluated");

  dag.applySourceChanges([["flag", -1]]);
  assert.equal(dag.evaluate("out"), -(2 * 3) + 1);
  assert.equal(calls.prod, 1);
  assert.equal(calls.sum, 1, "previously selected branch not re-evaluated after switch");
});

test("unselected branch with a throwing compute is never touched", () => {
  const dag = new DagEngine();
  dag.addSource("flag", 1);
  dag.addNode("ok", { kind: "derived", deps: ["flag"], compute: (v) => v[0] });
  dag.addNode("boom", {
    kind: "derived",
    deps: ["flag"],
    compute: () => {
      throw new Error("must never run");
    },
  });
  dag.addNode("pick", {
    kind: "conditional",
    conditionDeps: ["flag"],
    select: () => "safe",
    branches: {
      safe: { deps: ["ok"], compute: (v) => v[0] },
      unsafe: { deps: ["boom"], compute: (v) => v[0] },
    },
  });
  assert.equal(dag.evaluate("pick"), 1);
});

test("incremental recomputation only touches dirty nodes", () => {
  const calls: Counting = { sum: 0, prod: 0 };
  const dag = buildEngine(calls);
  dag.evaluate("out");
  const before = dag.computeCalls;
  dag.applySourceChanges([["s1", 5]]);
  dag.evaluate("out");
  // pos branch: recompute sum, pick, out — nothing else
  assert.equal(dag.computeCalls - before, 3);
  assert.equal(calls.prod, 0);
});

test("incremental engine matches full-evaluation model under random source changes", () => {
  const calls: Counting = { sum: 0, prod: 0 };
  const dag = buildEngine(calls);
  const rand = mulberry32(7);
  const outputs = ["out", "pick", "sum", "prod"];
  for (let round = 0; round < 100; round++) {
    dag.applySourceChanges([
      ["s1", Math.floor(rand() * 20) - 10],
      ["s2", Math.floor(rand() * 20) - 10],
      ["flag", rand() < 0.5 ? -1 : 1],
    ]);
    const actual = dag.evaluateOutputs(outputs);
    const expected = evaluateDagModel(dag.getSpecs(), dag.getSources(), outputs);
    assert.deepEqual(actual, expected, `round ${round}`);
  }
});

test("cycles and unknown references are rejected", () => {
  const dag = new DagEngine();
  dag.addNode("a", { kind: "derived", deps: ["b"], compute: (v) => v[0] });
  dag.addNode("b", { kind: "derived", deps: ["a"], compute: (v) => v[0] });
  assert.throws(() => dag.evaluate("a"), /cycle/);
  assert.throws(() => dag.evaluate("nope"), /unknown node/);

  const dag2 = new DagEngine();
  dag2.addSource("flag", 1);
  dag2.addNode("c", {
    kind: "conditional",
    conditionDeps: ["flag"],
    select: () => "missing",
    branches: { real: { deps: ["flag"], compute: (v) => v[0] } },
  });
  assert.throws(() => dag2.evaluate("c"), /no branch/);
});

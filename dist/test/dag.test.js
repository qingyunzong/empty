"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const dag_1 = require("../src/dag");
const helpers_1 = require("./helpers");
function buildEngine(calls) {
    const dag = new dag_1.DagEngine();
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
(0, node_test_1.default)("conditional dependencies evaluate only the selected branch", () => {
    const calls = { sum: 0, prod: 0 };
    const dag = buildEngine(calls);
    strict_1.default.equal(dag.evaluate("out"), (2 + 3) * 10 + 1);
    strict_1.default.equal(calls.sum, 1);
    strict_1.default.equal(calls.prod, 0, "unselected branch must not be evaluated");
    dag.applySourceChanges([["flag", -1]]);
    strict_1.default.equal(dag.evaluate("out"), -(2 * 3) + 1);
    strict_1.default.equal(calls.prod, 1);
    strict_1.default.equal(calls.sum, 1, "previously selected branch not re-evaluated after switch");
});
(0, node_test_1.default)("unselected branch with a throwing compute is never touched", () => {
    const dag = new dag_1.DagEngine();
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
    strict_1.default.equal(dag.evaluate("pick"), 1);
});
(0, node_test_1.default)("incremental recomputation only touches dirty nodes", () => {
    const calls = { sum: 0, prod: 0 };
    const dag = buildEngine(calls);
    dag.evaluate("out");
    const before = dag.computeCalls;
    dag.applySourceChanges([["s1", 5]]);
    dag.evaluate("out");
    // pos branch: recompute sum, pick, out — nothing else
    strict_1.default.equal(dag.computeCalls - before, 3);
    strict_1.default.equal(calls.prod, 0);
});
(0, node_test_1.default)("incremental engine matches full-evaluation model under random source changes", () => {
    const calls = { sum: 0, prod: 0 };
    const dag = buildEngine(calls);
    const rand = (0, helpers_1.mulberry32)(7);
    const outputs = ["out", "pick", "sum", "prod"];
    for (let round = 0; round < 100; round++) {
        dag.applySourceChanges([
            ["s1", Math.floor(rand() * 20) - 10],
            ["s2", Math.floor(rand() * 20) - 10],
            ["flag", rand() < 0.5 ? -1 : 1],
        ]);
        const actual = dag.evaluateOutputs(outputs);
        const expected = (0, dag_1.evaluateDagModel)(dag.getSpecs(), dag.getSources(), outputs);
        strict_1.default.deepEqual(actual, expected, `round ${round}`);
    }
});
(0, node_test_1.default)("cycles and unknown references are rejected", () => {
    const dag = new dag_1.DagEngine();
    dag.addNode("a", { kind: "derived", deps: ["b"], compute: (v) => v[0] });
    dag.addNode("b", { kind: "derived", deps: ["a"], compute: (v) => v[0] });
    strict_1.default.throws(() => dag.evaluate("a"), /cycle/);
    strict_1.default.throws(() => dag.evaluate("nope"), /unknown node/);
    const dag2 = new dag_1.DagEngine();
    dag2.addSource("flag", 1);
    dag2.addNode("c", {
        kind: "conditional",
        conditionDeps: ["flag"],
        select: () => "missing",
        branches: { real: { deps: ["flag"], compute: (v) => v[0] } },
    });
    strict_1.default.throws(() => dag2.evaluate("c"), /no branch/);
});

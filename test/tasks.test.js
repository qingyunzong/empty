import test from "node:test";
import assert from "node:assert/strict";
import { parseDfa, ValidationError } from "../src/dfa.js";
import { compareDfas } from "../src/equivalence.js";
import { buildTasks, minCostCover } from "../src/tasks.js";
import { analyze, InfeasibleError } from "../src/index.js";

function divergentMachines() {
  const oldRaw = {
    states: ["s0", "o1", "o2"],
    alphabet: ["a", "b"],
    start: "s0",
    risk: { s0: "low", o1: "high", o2: "high" },
    transitions: {
      s0: { a: "o1", b: "o2" },
      o1: { a: "o1", b: "o1" },
      o2: { a: "o2", b: "o2" },
    },
  };
  const newRaw = {
    states: ["t0", "n1", "n2"],
    alphabet: ["a", "b"],
    start: "t0",
    risk: { t0: "low", n1: "low", n2: "low" },
    transitions: {
      t0: { a: "n1", b: "n2" },
      n1: { a: "n1", b: "n1" },
      n2: { a: "n2", b: "n2" },
    },
  };
  return [oldRaw, newRaw];
}

test("tied optimal covers resolve deterministically by sorted id", () => {
  const [oldRaw, newRaw] = divergentMachines();
  const oldDfa = parseDfa(oldRaw, "old");
  const newDfa = parseDfa(newRaw, "new");
  const { divergentPairs } = compareDfas(oldDfa, newDfa);
  assert.equal(divergentPairs.length, 2);
  const tasks = buildTasks(oldDfa, newDfa, divergentPairs);
  assert.equal(tasks.length, 4);

  const runs = Array.from({ length: 5 }, () => minCostCover(tasks, divergentPairs.length));
  for (const cover of runs) {
    assert.equal(cover.cost, 2);
    assert.deepEqual(cover.ids, ["new:n1", "new:n2"]);
  }
});

test("budget below minimum cover cost is infeasible", () => {
  const [oldRaw, newRaw] = divergentMachines();
  assert.throws(() => analyze(oldRaw, newRaw, 1), (err) => {
    assert.ok(err instanceof InfeasibleError);
    assert.equal(err.minCost, 2);
    assert.equal(err.budget, 1);
    return true;
  });
  const ok = analyze(oldRaw, newRaw, 2);
  assert.equal(ok.equal, false);
  assert.equal(ok.cost, 2);
  assert.deepEqual(ok.tasks, [
    { id: "new:n1", cost: 1 },
    { id: "new:n2", cost: 1 },
  ]);
  assert.match(ok.planHash, /^[0-9a-f]{64}$/);
});

test("explicit costs drive the optimal choice", () => {
  const [oldRaw, newRaw] = divergentMachines();
  oldRaw.costs = { o1: 5, o2: 5 };
  newRaw.costs = { n1: 1, n2: 1 };
  const result = analyze(oldRaw, newRaw, 10);
  assert.deepEqual(result.tasks, [
    { id: "new:n1", cost: 1 },
    { id: "new:n2", cost: 1 },
  ]);
  assert.equal(result.cost, 2);
});

test("validation errors: negative budget, missing state, non-integer cost", () => {
  const [oldRaw, newRaw] = divergentMachines();
  assert.throws(() => analyze(oldRaw, newRaw, -1), ValidationError);
  assert.throws(() => analyze(oldRaw, newRaw, 1.5), ValidationError);

  const missingTarget = structuredClone(oldRaw);
  missingTarget.transitions.s0.a = "ghost";
  assert.throws(() => analyze(missingTarget, newRaw, 5), ValidationError);

  const missingRisk = structuredClone(oldRaw);
  delete missingRisk.risk.o1;
  assert.throws(() => analyze(missingRisk, newRaw, 5), ValidationError);

  const badCost = structuredClone(oldRaw);
  badCost.costs = { o1: 2.5 };
  assert.throws(() => analyze(badCost, newRaw, 5), ValidationError);

  const negativeCost = structuredClone(oldRaw);
  negativeCost.costs = { o1: -2 };
  assert.throws(() => analyze(negativeCost, newRaw, 5), ValidationError);
});

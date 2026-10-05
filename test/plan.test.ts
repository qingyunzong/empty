import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProblem } from "../src/model";
import { planTests } from "../src/plan";

function loadDemo() {
  const raw = JSON.parse(readFileSync("fixtures/demo.json", "utf8"));
  return parseProblem(raw);
}

test("demo fixture matches the hand-derived optimum to be 7 samples, lexicographic tie-break, 192 optima", () => {
  const result = planTests(loadDemo());
  assert.deepEqual(result.input, { strategies: 20, samples: 30 });
  assert.deepEqual(result.pairs, { total: 190, distinguishable: 189, equivalent: 1 });
  assert.equal(result.minimumSamples, 7);
  assert.deepEqual(result.selectedSamples, ["s01", "s02", "s03", "s04", "s06", "s07", "s08"]);
  assert.equal(result.verification.confirmed, true);
  assert.equal(result.verification.optimalSolutionCount, 192);
});

test("demo fixture reports the duplicated strategy as an equivalence class with evidence", () => {
  const result = planTests(loadDemo());
  assert.equal(result.equivalenceClasses.length, 1);
  const klass = result.equivalenceClasses[0]!;
  assert.deepEqual(klass.strategies, ["P19", "P20"]);
  assert.match(klass.evidence.reason, /identical outputs on all 30 candidate sample/);
  assert.equal(Object.keys(klass.evidence.identicalOutputs).length, 30);
  assert.equal(klass.evidence.identicalOutputs["s05"], 1);
  assert.equal(klass.evidence.identicalOutputs["s09"], 1);
});

test("all-equivalent strategies select zero samples", () => {
  const problem = parseProblem({
    samples: ["s1", "s2"],
    strategies: [
      { id: "A", outputs: [1, 2] },
      { id: "B", outputs: [1, 2] },
      { id: "C", outputs: [1, 2] },
    ],
  });
  const result = planTests(problem);
  assert.equal(result.minimumSamples, 0);
  assert.deepEqual(result.selectedSamples, []);
  assert.equal(result.pairs.equivalent, 3);
  assert.equal(result.equivalenceClasses.length, 1);
  assert.deepEqual(result.equivalenceClasses[0]!.strategies, ["A", "B", "C"]);
  assert.equal(result.verification.confirmed, true);
  assert.equal(result.verification.optimalSolutionCount, 1);
});

test("verify:false skips the independent check", () => {
  const result = planTests(loadDemo(), { verify: false });
  assert.equal(result.verification.confirmed, false);
  assert.match(result.verification.method, /skipped/);
  assert.equal(result.verification.optimalSolutionCount, null);
});

test("tiny verify budget reports unconfirmed minimality instead of failing", () => {
  const result = planTests(loadDemo(), { verifyBudget: 10 });
  assert.equal(result.verification.confirmed, false);
  assert.equal(result.verification.budgetExhausted, true);
  assert.match(result.verification.note ?? "", /node budget/);
});

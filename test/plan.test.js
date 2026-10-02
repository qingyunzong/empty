import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PlanStore, PlanError, loadPlan, buildPlan, planHash } from "../src/plan.js";
import { makeTmpDir } from "../helpers/testing.js";

const sampleResult = {
  equal: false,
  witness: ["a"],
  tasks: [
    { id: "new:n1", cost: 1 },
    { id: "new:n2", cost: 1 },
  ],
  cost: 2,
};

test("save is atomic and load round-trips", () => {
  const dir = makeTmpDir();
  const path = join(dir, "plan.json");
  const store = new PlanStore(path);
  const plan = store.save(sampleResult);
  assert.ok(existsSync(path));
  assert.equal(plan.planHash, planHash(sampleResult));

  const loaded = loadPlan(path);
  assert.deepEqual(loaded, plan);

  const store2 = new PlanStore(path);
  assert.deepEqual(store2.load(), plan);
});

test("half-written plan is rejected and previous plan is kept", () => {
  const dir = makeTmpDir();
  const path = join(dir, "plan.json");
  const store = new PlanStore(path);
  const goodPlan = store.save(sampleResult);

  const goodText = readFileSync(path, "utf8");
  writeFileSync(path, goodText.slice(0, goodText.length / 2));

  assert.throws(() => store.load(), PlanError);
  assert.deepEqual(store.current, goodPlan);

  writeFileSync(path, JSON.stringify({ ...goodPlan, cost: 999 }));
  assert.throws(() => store.load(), PlanError);
  assert.deepEqual(store.current, goodPlan);

  writeFileSync(path, JSON.stringify(buildPlan({ equal: true, witness: null, tasks: [], cost: 0 })));
  const recovered = store.load();
  assert.equal(recovered.equal, true);
  assert.deepEqual(store.current, recovered);
});

test("plan hash is deterministic regardless of key order", () => {
  const a = buildPlan(sampleResult);
  const reordered = {
    cost: 2,
    tasks: [
      { cost: 1, id: "new:n1" },
      { cost: 1, id: "new:n2" },
    ],
    witness: ["a"],
    equal: false,
  };
  assert.equal(planHash(reordered), a.planHash);
});

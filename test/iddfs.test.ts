import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeProblem, ProblemDef, Problem, applyAction, initialState, isGoal } from "../src/model.js";
import { reachableClosure, shortestPlan } from "../src/bfs.js";
import { iddfs } from "../src/iddfs.js";
import { mulberry32, randomProblemDef } from "./randgen.js";

const load = (name: string): Problem =>
  normalizeProblem(
    JSON.parse(readFileSync(`examples/${name}`, "utf8")) as ProblemDef
  );

test("iddfs finds the optimum on the examples", () => {
  for (const name of ["lights.json", "rocket.json", "swap.json"]) {
    const p = load(name);
    const bfs = shortestPlan(p);
    const r = iddfs(p, Math.max(1, reachableClosure(p).size));
    assert.equal(r.length, bfs.goalDepth, name);
    // replay
    let s = initialState(p);
    for (const i of r.plan!) {
      s = applyAction(p, s, p.actions[i]!)!;
      assert.ok(s);
    }
    assert.ok(isGoal(p, s.bits));
  }
});

test("learning never excludes unexplored feasible paths: iddfs == BFS on random problems", () => {
  const rnd = mulberry32(4242);
  let solved = 0;
  let totalPrunes = 0;
  for (let t = 0; t < 40; t++) {
    const p = normalizeProblem(randomProblemDef(rnd, { maxBits: 4 }));
    const closure = reachableClosure(p);
    const bfs = shortestPlan(p);
    const r = iddfs(p, Math.max(1, closure.size));
    assert.equal(r.length, bfs.goalDepth, `problem ${t}: iddfs must match BFS optimum`);
    totalPrunes += r.learnedPrunes;
    if (r.plan) {
      solved++;
      let s = initialState(p);
      for (const i of r.plan) s = applyAction(p, s, p.actions[i]!)!;
      assert.ok(isGoal(p, s.bits), `problem ${t}: iddfs plan must reach the goal`);
    }
  }
  assert.ok(solved > 10, `expected enough solvable random problems, got ${solved}`);
  assert.ok(totalPrunes > 0, "expected learning to actually prune somewhere");
});

test("learning prunes on a directed diamond problem", () => {
  // forbid-guarded one-way actions form diamonds without self-loops, so
  // states are fully explored and later revisited with smaller budget:
  // learned failure certificates must fire, without losing the optimum.
  const p = normalizeProblem({
    bits: 4,
    initial: 0,
    goal: { requireMask: 15 },
    actions: [
      { name: "p", forbidMask: 1, setMask: 1 },
      { name: "q", forbidMask: 2, setMask: 2 },
      { name: "r", requireMask: 1, forbidMask: 4, setMask: 4 },
      { name: "s", requireMask: 2, forbidMask: 4, setMask: 4 },
      { name: "u", requireMask: 4, forbidMask: 8, setMask: 8 },
    ],
  });
  const bfs = shortestPlan(p);
  const r = iddfs(p, 8);
  assert.equal(bfs.goalDepth, 4);
  assert.equal(r.length, 4);
  assert.ok(r.learnedStates > 0, "expected learned failure certificates");
  assert.ok(r.learnedPrunes > 0, "expected learned prunes");
});

test("iddfs reports unsolvable when the goal is unreachable", () => {
  const p = normalizeProblem({
    bits: 2,
    initial: 0,
    goal: { requireMask: 2 },
    actions: [{ name: "only-0", setMask: 1 }],
  });
  const r = iddfs(p, 8);
  assert.equal(r.plan, null);
  assert.equal(r.length, null);
});

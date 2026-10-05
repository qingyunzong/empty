import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeProblem, ProblemDef, applyAction, initialState, isGoal } from "../src/model.js";
import { Bfs, reachableClosure, shortestPlan } from "../src/bfs.js";
import { dfsClosure } from "../src/iddfs.js";
import { mulberry32, randomProblemDef } from "./randgen.js";

const lights = normalizeProblem(
  JSON.parse(readFileSync("examples/lights.json", "utf8")) as ProblemDef
);

test("BFS finds the shortest certificate on the lights example", () => {
  const r = shortestPlan(lights);
  assert.equal(r.goalDepth, 4);
  assert.equal(r.plan!.length, 4);
  // replay the certificate
  let s = initialState(lights);
  for (const i of r.plan!) {
    const next = applyAction(lights, s, lights.actions[i]!);
    assert.ok(next, `action ${lights.actions[i]!.name} must be applicable`);
    s = next!;
  }
  assert.ok(isGoal(lights, s.bits));
});

test("BFS closure depths are exact shortest distances (lights)", () => {
  const closure = reachableClosure(lights);
  // switches only turn bits on (in chain order); reset clears everything,
  // so the reachable closure is exactly {0,1,3,7,15}
  assert.equal(closure.size, 5);
  assert.equal(closure.get("0"), 0);
  assert.equal(closure.get("15"), 4);
  assert.equal(closure.get("1"), 1);
  assert.equal(closure.get("3"), 2);
  assert.equal(closure.get("7"), 3);
});

test("BFS closure and DFS closure agree on random problems", () => {
  const rnd = mulberry32(12345);
  for (let t = 0; t < 40; t++) {
    const p = normalizeProblem(randomProblemDef(rnd));
    const bfs = reachableClosure(p);
    const dfs = dfsClosure(p);
    assert.equal(dfs.size, bfs.size, `problem ${t}: reachable set size`);
    for (const k of bfs.keys()) assert.ok(dfs.has(k), `problem ${t}: missing ${k}`);
  }
});

test("BFS visit order is breadth-first (non-decreasing depth)", () => {
  const b = new Bfs(lights, { stopAtGoal: false });
  b.run();
  const depths = b.visitDepths;
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i]! >= depths[i - 1]!, "BFS expands in non-decreasing depth");
  }
});

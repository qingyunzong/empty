import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeProblem,
  ProblemDef,
  Problem,
  stateKey,
} from "../src/model.js";
import { Bfs, reachableClosure, shortestPlan } from "../src/bfs.js";
import { astar, checkLowerBound, lowerBound } from "../src/heuristic.js";
import { mulberry32, randomProblemDef } from "./randgen.js";

const load = (name: string): Problem =>
  normalizeProblem(
    JSON.parse(readFileSync(`examples/${name}`, "utf8")) as ProblemDef
  );

const lights = load("lights.json");
const rocket = load("rocket.json");

test("lower bound on lights initial state equals the optimum (4)", () => {
  const lb = lowerBound(lights, lights.initial);
  assert.equal(lb.value, 4);
  assert.deepEqual(lb.trueDist, [1, 2, 3, 4]);
  assert.ok(checkLowerBound(lights, lights.initial, lb));
});

test("lower bound is 0 exactly on goal states (lights)", () => {
  assert.equal(lowerBound(lights, 15).value, 0);
  assert.ok(lowerBound(lights, 7).value > 0);
});

test("dead end detection: unsatisfiable goal bit yields Infinity", () => {
  const p = normalizeProblem({
    bits: 2,
    initial: 0,
    goal: { requireMask: 2 },
    actions: [{ name: "only-0", setMask: 1 }],
  });
  assert.equal(lowerBound(p, 0).value, Infinity);
});

test("checkLowerBound rejects tampered certificates", () => {
  const lb = lowerBound(lights, lights.initial);
  assert.ok(!checkLowerBound(lights, lights.initial, { ...lb, value: lb.value + 1 }));
  const tampered = [...lb.trueDist];
  tampered[3] = 99;
  assert.ok(!checkLowerBound(lights, lights.initial, { ...lb, trueDist: tampered }));
});

test("A* matches BFS optimum on examples and emits valid bound certificates", () => {
  for (const p of [lights, rocket]) {
    const bfs = shortestPlan(p);
    const a = astar(p);
    assert.equal(a.length, bfs.goalDepth);
    for (const rec of a.bounds) {
      const recomputed = lowerBound(p, rec.bits);
      assert.equal(rec.h, recomputed.value, `bound certificate for ${rec.key}`);
      assert.ok(rec.f === rec.g + rec.h, "f = g + h");
    }
    const h0 = lowerBound(p, p.initial).value;
    assert.ok(h0 <= (a.length ?? Infinity));
  }
});

test("exhaustive admissibility: h(s) <= h*(s) over the full reachable closure", () => {
  const rnd = mulberry32(2024);
  const problems = 25;
  for (let t = 0; t < problems; t++) {
    const p = normalizeProblem(randomProblemDef(rnd, { maxBits: 4 }));
    const closure = reachableClosure(p);
    for (const [key] of closure) {
      const [bitsStr, resStr] = key.split("|");
      const bits = Number(bitsStr);
      const res = resStr ? resStr.split(",").map(Number) : [];
      // true remaining cost h*(s): fresh BFS from this state
      const from = new Bfs(p, { start: { bits, res } });
      const r = from.run();
      const hStar = r.goalDepth; // null = unreachable
      const h = lowerBound(p, bits).value;
      if (hStar === null) {
        // goal unreachable; any finite h is trivially admissible, but
        // h = Infinity must never occur for a state that CAN reach the goal
        continue;
      }
      assert.ok(h <= hStar, `problem ${t} state ${key}: h=${h} > h*=${hStar}`);
    }
    // h = Infinity must be a sound dead-end proof
    for (const [key] of closure) {
      const bits = Number(key.split("|")[0]);
      const res = key.includes("|") ? key.split("|")[1]!.split(",").map(Number) : [];
      const h = lowerBound(p, bits).value;
      if (h === Infinity) {
        const r = new Bfs(p, { start: { bits, res } }).run();
        assert.equal(r.goalDepth, null, `problem ${t} state ${key}: h=Infinity but goal reachable`);
      }
    }
  }
});

test("A* with pruning matches full BFS on random small problems", () => {
  const rnd = mulberry32(99);
  for (let t = 0; t < 60; t++) {
    const p = normalizeProblem(randomProblemDef(rnd, { maxBits: 5 }));
    const bfs = shortestPlan(p);
    const a = astar(p);
    assert.equal(a.length, bfs.goalDepth, `problem ${t}: A* vs BFS optimum`);
    const h0 = lowerBound(p, p.initial).value;
    if (bfs.goalDepth !== null) {
      assert.ok(h0 <= bfs.goalDepth, `problem ${t}: initial bound ${h0} <= ${bfs.goalDepth}`);
    }
    // every emitted bound certificate must recompute exactly (auditable)
    for (const rec of a.bounds) {
      assert.equal(lowerBound(p, rec.bits).value, rec.h, `problem ${t}: bound audit for ${rec.key}`);
    }
  }
});

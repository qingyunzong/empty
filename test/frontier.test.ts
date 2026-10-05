import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProblem } from "../src/model.js";
import { Search, serializeSnapshot, deserializeSnapshot } from "../src/frontier.js";
import { makeHeuristic } from "../src/heuristic.js";
import { shortestPlan } from "../src/bfs.js";
import { randomProblem } from "./helpers.js";

const robot = parseProblem(JSON.parse(readFileSync("examples/robot.json", "utf8")));

function fullRun(p: ReturnType<typeof parseProblem>, mode: "bfs" | "astar"): string[] {
  const h = mode === "astar" ? makeHeuristic(p) : () => 0;
  const s = new Search(p, mode, h);
  s.run();
  return [...s.visitLog];
}

function pausedRun(
  p: ReturnType<typeof parseProblem>,
  mode: "bfs" | "astar",
  pauses: number[],
): string[] {
  const h = mode === "astar" ? makeHeuristic(p) : () => 0;
  let search = new Search(p, mode, h);
  for (const pauseAt of pauses) {
    search.run(pauseAt);
    // Serialize to JSON and restore — a full pause/resume cycle.
    const snap = deserializeSnapshot(serializeSnapshot(search.snapshot()));
    search = Search.fromSnapshot(p, snap, h);
  }
  search.run();
  return [...search.visitLog];
}

test("BFS pause/resume preserves exact visit order (robot)", () => {
  const full = fullRun(robot, "bfs");
  for (const pauses of [[1], [3], [2, 4], [1, 2, 3], [0], [full.length]]) {
    assert.deepEqual(pausedRun(robot, "bfs", pauses), full, `pauses=${pauses}`);
  }
});

test("A* pause/resume preserves exact visit order (robot)", () => {
  const full = fullRun(robot, "astar");
  for (const pauses of [[1], [2, 3]]) {
    assert.deepEqual(pausedRun(robot, "astar", pauses), full, `pauses=${pauses}`);
  }
});

test("resumed search finds the same optimal plan as BFS", () => {
  const search = new Search(robot, "bfs");
  search.run(2);
  const snap = deserializeSnapshot(serializeSnapshot(search.snapshot()));
  const resumed = Search.fromSnapshot(robot, snap);
  resumed.run();
  const plan = resumed.plan();
  assert.ok(plan);
  assert.equal(plan.length, shortestPlan(robot)!.length);
});

test("pause/resume on random problems matches uninterrupted order", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const p = randomProblem(seed);
    const full = fullRun(p, "bfs");
    const paused = pausedRun(p, "bfs", [1, 3, 5]);
    assert.deepEqual(paused, full, `seed ${seed}`);
  }
});

test("snapshot round-trips through JSON structurally", () => {
  const search = new Search(robot, "bfs");
  search.run(3);
  const snap = search.snapshot();
  const restored = deserializeSnapshot(serializeSnapshot(snap));
  assert.deepEqual(restored, snap);
});

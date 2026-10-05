import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeProblem, ProblemDef } from "../src/model.js";
import { Bfs, Snapshot } from "../src/bfs.js";
import { mulberry32, randomProblemDef } from "./randgen.js";

const rocket = normalizeProblem(
  JSON.parse(readFileSync("examples/rocket.json", "utf8")) as ProblemDef
);

function pauseResumeSameOrder(p: ReturnType<typeof normalizeProblem>, stopAtGoal: boolean, pauses: number[]): void {
  const ref = new Bfs(p, { stopAtGoal });
  const full = ref.run();
  for (const k of pauses) {
    const b = new Bfs(p, { stopAtGoal });
    b.run(k); // pause after k expansions
    const snapJson = b.snapshotJson();
    const restored = Bfs.restore(p, JSON.parse(snapJson) as Snapshot);
    const resumed = restored.run();
    assert.deepEqual(
      resumed.visitOrder,
      full.visitOrder,
      `visit order after pause@${k} must equal the uninterrupted order`
    );
    assert.deepEqual(resumed.plan, full.plan);
    assert.equal(resumed.goalDepth, full.goalDepth);
    assert.deepEqual([...resumed.closure.entries()].sort(), [...full.closure.entries()].sort());
  }
}

test("frontier serialization: pause/resume preserves visit order (rocket, with resources)", () => {
  pauseResumeSameOrder(rocket, true, [0, 1, 2, 3, 5, 8]);
  pauseResumeSameOrder(rocket, false, [0, 1, 4, 10]);
});

test("frontier serialization: pause/resume preserves visit order (random problems)", () => {
  const rnd = mulberry32(777);
  for (let t = 0; t < 15; t++) {
    const p = normalizeProblem(randomProblemDef(rnd));
    pauseResumeSameOrder(p, false, [0, 1, 3]);
  }
});

test("snapshot round-trips through JSON structurally", () => {
  const b = new Bfs(rocket);
  b.run(3);
  const snap = b.snapshot();
  const restored = Bfs.restore(rocket, JSON.parse(JSON.stringify(snap)) as Snapshot);
  assert.deepEqual(restored.snapshot(), snap);
});

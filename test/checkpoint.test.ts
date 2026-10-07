import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePuzzle } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { Solver, Checkpoint } from '../src/solver.js';

const PUZZLE = {
  width: 5,
  height: 4,
  start: [0, 1] as [number, number],
  enemies: [
    [1, 1],
    [3, 1],
    [2, 2],
  ] as [number, number][],
  obstacles: [
    [3, 2],
    [3, 0],
  ] as [number, number][],
  toggle: [2, 1] as [number, number],
  directions: [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as [number, number][],
  altDirections: [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as [number, number][],
};

function freshSolver() {
  return new Solver(new Engine(parsePuzzle(PUZZLE)));
}

test('checkpoint round-trip reproduces the uninterrupted result', () => {
  const reference = freshSolver().run()!;

  // run in many small slices, checkpointing (through JSON) between slices
  let solver = freshSolver();
  let result = null;
  for (let slice = 0; slice < 500 && result === null; slice++) {
    result = solver.run(3); // finalize at most 3 states per slice
    if (result === null) {
      const json = JSON.stringify(solver.toCheckpoint());
      solver = Solver.fromCheckpoint(JSON.parse(json) as Checkpoint);
    }
  }
  assert.ok(result !== null, 'sliced search should finish');
  assert.deepEqual(result, reference);
});

test('checkpoint preserves stats and memo', () => {
  const solver = freshSolver();
  solver.run(7);
  const cp = solver.toCheckpoint();
  const restored = Solver.fromCheckpoint(JSON.parse(JSON.stringify(cp)) as Checkpoint);
  assert.deepEqual(restored.stats, solver.stats);
  assert.equal(restored.memo.size, solver.memo.size);
  const r1 = restored.run()!;
  const r2 = freshSolver().run()!;
  assert.deepEqual(r1, r2);
});

test('a completed solver checkpoints as done', () => {
  const solver = freshSolver();
  solver.run();
  const cp = solver.toCheckpoint();
  assert.equal(cp.done, true);
  const restored = Solver.fromCheckpoint(cp);
  assert.deepEqual(restored.run(), cp.result);
});

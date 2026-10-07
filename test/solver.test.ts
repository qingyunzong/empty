import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePuzzle, PuzzleJson } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { Solver } from '../src/solver.js';

const ORTHO: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function solve(j: PuzzleJson) {
  const eng = new Engine(parsePuzzle(j));
  const solver = new Solver(eng);
  const result = solver.run();
  assert.ok(result !== null);
  return { eng, result, solver };
}

test('straight chain: two captures in a row', () => {
  const { eng, result } = solve({
    width: 5,
    height: 1,
    start: [0, 0],
    enemies: [[1, 0], [3, 0]],
    directions: [[1, 0]],
  });
  assert.equal(result.captures, 2);
  assert.deepEqual(result.jumpSeq, [eng.cell(2, 0), eng.cell(4, 0)]);
  assert.equal(result.moves.length, 2);
});

test('lexicographic tie-break picks the smaller landing cell', () => {
  const { eng, result } = solve({
    width: 5,
    height: 1,
    start: [2, 0],
    enemies: [[1, 0], [3, 0]],
    directions: ORTHO,
  });
  assert.equal(result.captures, 1);
  assert.deepEqual(result.jumpSeq, [eng.cell(0, 0)]);
});

test('bent chain: capture, turn, capture', () => {
  const { eng, result } = solve({
    width: 3,
    height: 3,
    start: [0, 0],
    enemies: [[1, 0], [2, 1]],
    directions: ORTHO,
  });
  assert.equal(result.captures, 2);
  assert.deepEqual(result.jumpSeq, [eng.cell(2, 0), eng.cell(2, 2)]);
});

test('push repositions the piece to enable a capture', () => {
  const { result } = solve({
    width: 3,
    height: 3,
    start: [0, 0],
    enemies: [[1, 1]],
    obstacles: [[1, 0]],
    directions: ORTHO,
  });
  assert.equal(result.captures, 1);
  assert.equal(result.moves.length, 2);
  assert.equal(result.moves[0]!.kind, 'push');
  assert.equal(result.moves[1]!.kind, 'jump');
});

test('obstacle on the landing cell prevents the jump', () => {
  const { result } = solve({
    width: 3,
    height: 1,
    start: [0, 0],
    enemies: [[1, 0]],
    obstacles: [[2, 0]],
    directions: [[1, 0]],
  });
  assert.equal(result.captures, 0);
  assert.equal(result.moves.length, 0);
});

test('toggle unlocks captures in the new direction set', () => {
  const { eng, result } = solve({
    width: 5,
    height: 3,
    start: [0, 0],
    enemies: [[1, 0], [3, 1]],
    toggle: [2, 0],
    directions: ORTHO,
    altDirections: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  });
  assert.equal(result.captures, 2);
  assert.deepEqual(result.jumpSeq, [eng.cell(2, 0), eng.cell(4, 2)]);
});

test('toggle can make a previously jumpable enemy unjumpable', () => {
  // After landing on the toggle the direction set becomes left-only, so the
  // enemy at (3,0) can no longer be jumped from (2,0); the optimum is 1.
  const { result } = solve({
    width: 5,
    height: 1,
    start: [0, 0],
    enemies: [[1, 0], [3, 0]],
    toggle: [2, 0],
    directions: [[1, 0]],
    altDirections: [[-1, 0]],
  });
  assert.equal(result.captures, 1);
  assert.deepEqual(result.jumpSeq, [2]);
});

test('12 enemies in a chain are all captured', () => {
  const enemies: [number, number][] = [];
  for (let i = 0; i < 12; i++) enemies.push([1 + 2 * i, 0]);
  const { result } = solve({
    width: 25,
    height: 1,
    start: [0, 0],
    enemies,
    directions: [[1, 0]],
  });
  assert.equal(result.captures, 12);
  assert.equal(result.moves.length, 12);
});

test('no moves at all yields the empty result', () => {
  const { result } = solve({
    width: 2,
    height: 2,
    start: [0, 0],
    enemies: [[1, 1]],
    directions: ORTHO,
  });
  assert.equal(result.captures, 0);
  assert.deepEqual(result.jumpSeq, []);
});

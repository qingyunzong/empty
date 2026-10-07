import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePuzzle, PuzzleJson } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { Solver } from '../src/solver.js';
import { bfsStateSpace, exhaustiveSearch } from '../src/brute.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIR_POOLS: [number, number][][] = [
  [[1, 0], [-1, 0], [0, 1], [0, -1]],
  [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  [[1, 0], [0, 1]],
  [[2, 1], [1, 2], [-1, 2]],
  [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]],
];

function randomPuzzle(rand: () => number): PuzzleJson {
  const w = 3 + Math.floor(rand() * 2); // 3..4
  const h = 3 + Math.floor(rand() * 2); // 3..4
  const cells: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push([x, y]);
  const take = (): [number, number] => cells.splice(Math.floor(rand() * cells.length), 1)[0]!;
  const start = take();
  const nEnemies = 1 + Math.floor(rand() * 3); // 1..3
  const enemies = Array.from({ length: nEnemies }, take);
  const nObstacles = Math.floor(rand() * 2); // 0..1
  const obstacles = Array.from({ length: nObstacles }, take);
  const withToggle = rand() < 0.5;
  const toggle = withToggle ? take() : null;
  const directions = DIR_POOLS[Math.floor(rand() * DIR_POOLS.length)]!;
  const altDirections = withToggle ? DIR_POOLS[Math.floor(rand() * DIR_POOLS.length)]! : null;
  return { width: w, height: h, start, enemies, obstacles, toggle, directions, altDirections };
}

test('solver matches full state-space BFS and memo-free enumeration on small boards', () => {
  const rand = mulberry32(20261007);
  let checked = 0;
  for (let i = 0; i < 60; i++) {
    const puzzle = parsePuzzle(randomPuzzle(rand));
    const engine = new Engine(puzzle);
    const solver = new Solver(engine);
    const result = solver.run()!;

    const bfs = bfsStateSpace(engine, 2_000_000);
    assert.equal(
      result.captures,
      bfs.maxCaptures,
      `case ${i}: solver=${result.captures} bfs=${bfs.maxCaptures}`,
    );

    const ex = exhaustiveSearch(engine, 2_000_000);
    assert.equal(ex.result.captures, result.captures, `case ${i} captures`);
    assert.deepEqual(ex.result.jumpSeq, result.jumpSeq, `case ${i} jump sequence`);
    assert.equal(ex.result.moves.length, result.moves.length, `case ${i} move count`);
    checked++;
  }
  assert.equal(checked, 60);
});

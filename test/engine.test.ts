import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePuzzle } from '../src/model.js';
import { Engine } from '../src/engine.js';

const ORTHO: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

test('parse: rejects too many enemies / obstacles', () => {
  const base = { width: 5, height: 5, start: [0, 0], directions: ORTHO };
  const enemies = Array.from({ length: 13 }, (_, i) => [i % 5, 1 + Math.floor(i / 5)]);
  assert.throws(() => parsePuzzle({ ...base, enemies }), /too many enemies/);
  const obstacles = Array.from({ length: 7 }, (_, i) => [i, 1]);
  assert.throws(() => parsePuzzle({ ...base, obstacles }), /too many obstacles/);
});

test('parse: toggle requires altDirections and vice versa', () => {
  const base = { width: 3, height: 3, start: [0, 0], directions: ORTHO };
  assert.throws(() => parsePuzzle({ ...base, toggle: [1, 1] }), /altDirections is required/);
  assert.throws(
    () => parsePuzzle({ ...base, altDirections: [[1, 1]] }),
    /no toggle square/,
  );
});

test('parse: rejects duplicates, zero vector, overlaps, out of bounds', () => {
  const base = { width: 3, height: 3, start: [0, 0], directions: ORTHO };
  assert.throws(() => parsePuzzle({ ...base, enemies: [[1, 1], [1, 1]] }), /duplicate enemy/);
  assert.throws(
    () => parsePuzzle({ ...base, directions: [[0, 0]] }),
    /zero vector/,
  );
  assert.throws(
    () => parsePuzzle({ ...base, directions: [[1, 0], [1, 0]] }),
    /duplicate direction/,
  );
  assert.throws(() => parsePuzzle({ ...base, enemies: [[0, 0]] }), /distinct cells/);
  assert.throws(() => parsePuzzle({ ...base, enemies: [[9, 9]] }), /out of bounds/);
  assert.throws(() => parsePuzzle({ ...base, toggle: [0, 0], altDirections: [[1, 1]] }), /toggle square must be empty/);
});

test('engine: jump generation and capture', () => {
  const p = parsePuzzle({
    width: 5,
    height: 1,
    start: [0, 0],
    enemies: [[1, 0]],
    directions: [[1, 0]],
  });
  const eng = new Engine(p);
  const s0 = eng.initialState();
  const moves = eng.genMoves(s0);
  assert.equal(moves.length, 1);
  assert.equal(moves[0]!.kind, 'jump');
  const s1 = eng.apply(s0, moves[0]!);
  assert.equal(s1.pos, 2);
  assert.equal(s1.enemies, 0);
  assert.equal(eng.genMoves(s1).length, 0);
});

test('engine: obstacle blocks a jump landing; pushes move it', () => {
  const p = parsePuzzle({
    width: 3,
    height: 3,
    start: [0, 0],
    enemies: [[1, 1]],
    obstacles: [[1, 0]],
    directions: ORTHO,
  });
  const eng = new Engine(p);
  const s0 = eng.initialState();
  const moves = eng.genMoves(s0);
  // no jump possible (enemy is diagonal); exactly one push to the right
  assert.equal(moves.length, 1);
  assert.equal(moves[0]!.kind, 'push');
  const s1 = eng.apply(s0, moves[0]!);
  assert.equal(s1.pos, 1); // (1,0)
  assert.deepEqual(s1.obstacles, [2]); // obstacle slid to (2,0)
  const moves1 = eng.genMoves(s1);
  assert.equal(moves1.length, 1);
  assert.equal(moves1[0]!.kind, 'jump'); // jump down over (1,1) to (1,2)
  const s2 = eng.apply(s1, moves1[0]!);
  assert.equal(s2.enemies, 0);
});

test('engine: toggle switches the direction set when landed on', () => {
  const p = parsePuzzle({
    width: 5,
    height: 3,
    start: [0, 0],
    enemies: [[1, 0], [3, 1]],
    toggle: [2, 0],
    directions: ORTHO,
    altDirections: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  });
  const eng = new Engine(p);
  const s0 = eng.initialState();
  const jump = eng.genMoves(s0).find((m) => m.kind === 'jump')!;
  const s1 = eng.apply(s0, jump);
  assert.equal(s1.toggled, true);
  assert.equal(s1.pos, 2); // landed on the toggle square (2,0)
  // now only diagonal jumps exist: over (3,1) landing (4,2)
  const moves = eng.genMoves(s1);
  assert.equal(moves.length, 1);
  assert.equal(moves[0]!.to, eng.cell(4, 2));
});

test('engine: toggle does not trigger when passed over or before landing', () => {
  const p = parsePuzzle({
    width: 5,
    height: 1,
    start: [0, 0],
    enemies: [[1, 0]],
    toggle: [3, 0],
    directions: [[1, 0]],
    altDirections: [[-1, 0]],
  });
  const eng = new Engine(p);
  const s1 = eng.apply(eng.initialState(), eng.genMoves(eng.initialState())[0]!);
  // landed on (2,0), toggle at (3,0) untouched
  assert.equal(s1.toggled, false);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePuzzle } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { Solver } from '../src/solver.js';
import {
  buildCertificate,
  verifyCertificate,
  safeUpperBound,
} from '../src/certificate.js';

const TOGGLE_PUZZLE = {
  width: 5,
  height: 3,
  start: [0, 0] as [number, number],
  enemies: [
    [1, 0],
    [3, 1],
  ] as [number, number][],
  toggle: [2, 0] as [number, number],
  directions: [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as [number, number][],
  altDirections: [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as [number, number][],
};

function solvedCert(puzzleJson: unknown) {
  const engine = new Engine(parsePuzzle(puzzleJson));
  const solver = new Solver(engine);
  const result = solver.run()!;
  const cert = buildCertificate(engine, result, { ...solver.stats, memoSize: solver.memo.size });
  return { engine, result, cert };
}

test('certificate verifies and the bound is safe', () => {
  const { engine, result, cert } = solvedCert(TOGGLE_PUZZLE);
  const check = verifyCertificate(engine, cert);
  assert.deepEqual(check.problems, []);
  assert.ok(check.ok);
  assert.ok(cert.safeUpperBound >= cert.optimalCaptures);
  assert.ok(cert.safeUpperBound <= cert.totalEnemies);
  assert.equal(cert.optimalCaptures, result.captures);
});

test('corner enemies are excluded from the safe upper bound', () => {
  // enemy at (0,1) of a 1-wide board can never be jumped with (1,0) only
  const engine = new Engine(
    parsePuzzle({
      width: 3,
      height: 1,
      start: [0, 0],
      enemies: [[2, 0]],
      directions: [[1, 0]],
    }),
  );
  // enemy at (2,0): needs cells (1,0) and (3,0); (3,0) is off-board -> bound 0
  assert.equal(safeUpperBound(engine), 0);
  const solver = new Solver(engine);
  assert.equal(solver.run()!.captures, 0);
});

test('tampered certificates are rejected', () => {
  const { engine, cert } = solvedCert(TOGGLE_PUZZLE);
  const bad1 = { ...cert, optimalCaptures: cert.optimalCaptures + 1 };
  assert.equal(verifyCertificate(engine, bad1).ok, false);
  const bad2 = { ...cert, finalState: { ...cert.finalState, pos: 0 } };
  assert.equal(verifyCertificate(engine, bad2).ok, false);
  const bad3 = { ...cert, stepHashes: [...cert.stepHashes].reverse() };
  assert.equal(verifyCertificate(engine, bad3).ok, false);
  const bad4 = { ...cert, puzzleHash: '0'.repeat(64) };
  assert.equal(verifyCertificate(engine, bad4).ok, false);
});

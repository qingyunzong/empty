import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffLines,
  applyHunks,
  editCount,
  exhaustiveOps,
  myersOps,
  opsToHunks,
  EXHAUSTIVE_LIMIT,
  type Hunk,
} from '../src/diff.js';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDoc(rand: () => number, len: number): string[] {
  const alpha = ['a', 'b', 'c', 'd'];
  return Array.from({ length: len }, () => alpha[Math.floor(rand() * alpha.length)]);
}

test('exhaustive: identical documents produce no hunks', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), []);
});

test('exhaustive: pure insertion at end', () => {
  assert.deepEqual(diffLines(['a'], ['a', 'b']), [
    { baseStart: 1, baseEnd: 1, lines: ['b'] },
  ]);
});

test('exhaustive: pure insertion at start', () => {
  assert.deepEqual(diffLines(['b'], ['a', 'b']), [
    { baseStart: 0, baseEnd: 0, lines: ['a'] },
  ]);
});

test('exhaustive: pure deletion', () => {
  assert.deepEqual(diffLines(['a', 'x', 'b'], ['a', 'b']), [
    { baseStart: 1, baseEnd: 2, lines: [] },
  ]);
});

test('exhaustive: replacement', () => {
  assert.deepEqual(diffLines(['a', 'x', 'b'], ['a', 'y', 'b']), [
    { baseStart: 1, baseEnd: 2, lines: ['y'] },
  ]);
});

test('exhaustive: empty base to non-empty', () => {
  assert.deepEqual(diffLines([], ['a', 'b']), [
    { baseStart: 0, baseEnd: 0, lines: ['a', 'b'] },
  ]);
});

test('exhaustive: non-empty to empty', () => {
  assert.deepEqual(diffLines(['a', 'b'], []), [
    { baseStart: 0, baseEnd: 2, lines: [] },
  ]);
});

test('exhaustive: adjacent delete+insert coalesce into one hunk', () => {
  const hunks = diffLines(['a', 'b', 'c'], ['a', 'x', 'y']);
  assert.deepEqual(hunks, [{ baseStart: 1, baseEnd: 3, lines: ['x', 'y'] }]);
});

test('exhaustive enumeration finds minimal scripts (known distances)', () => {
  assert.equal(editCount(diffLines(['a', 'b', 'c'], ['a', 'b', 'c'])), 0);
  assert.equal(editCount(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])), 2); // del+ins
  assert.equal(editCount(diffLines(['a', 'b', 'c'], ['c', 'b', 'a'])), 4); // del a,c + ins c,a
  assert.equal(editCount(diffLines([], ['a', 'b', 'c'])), 3);
});

test('exhaustive vs myers agree on random short documents', () => {
  const rand = mulberry32(42);
  for (let iter = 0; iter < 500; iter++) {
    const a = randomDoc(rand, Math.floor(rand() * (EXHAUSTIVE_LIMIT + 1)));
    const b = randomDoc(rand, Math.floor(rand() * 9));
    const he = opsToHunks(a, b, exhaustiveOps(a, b));
    const hm = opsToHunks(a, b, myersOps(a, b));
    // both transform a into b
    assert.deepEqual(applyHunks(a, he), b, `exhaustive apply ${iter}`);
    assert.deepEqual(applyHunks(a, hm), b, `myers apply ${iter}`);
    // both are minimal
    assert.equal(editCount(he), editCount(hm), `minimality ${iter}`);
  }
});

test('myers: longer documents apply cleanly', () => {
  const rand = mulberry32(7);
  for (let iter = 0; iter < 100; iter++) {
    const a = randomDoc(rand, 13 + Math.floor(rand() * 30));
    const b = randomDoc(rand, Math.floor(rand() * 30));
    const hunks = diffLines(a, b); // exercises the myers path (a > LIMIT)
    assert.deepEqual(applyHunks(a, hunks), b);
  }
});

test('myers: realistic long edit', () => {
  const base = Array.from({ length: 50 }, (_, i) => `line${i}`);
  const modified = base.slice();
  modified.splice(10, 1, 'changed10');
  modified.splice(30, 3);
  modified.splice(40, 0, 'new1', 'new2');
  const hunks: Hunk[] = diffLines(base, modified);
  assert.deepEqual(applyHunks(base, hunks), modified);
  assert.equal(hunks.length, 3);
});

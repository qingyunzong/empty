import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffLines,
  diffOps,
  exhaustiveOps,
  myersOps,
  type Op,
} from '../src/diff.js';

function applyOps(a: string[], ops: Op[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (const op of ops) {
    if (op.type === 'keep') {
      assert.equal(op.line, a[i], 'keep op must match base line');
      out.push(op.line);
      i++;
    } else if (op.type === 'del') {
      assert.equal(op.line, a[i], 'del op must match base line');
      i++;
    } else {
      out.push(op.line);
    }
  }
  assert.equal(i, a.length, 'all base lines must be consumed');
  return out;
}

function editCost(ops: Op[]): number {
  return ops.filter((op) => op.type !== 'keep').length;
}

/** Brute-force enumeration of every direct edit combination turning a into b. */
function* allEditScripts(a: string[], b: string[], i = 0, j = 0, acc: Op[] = []): Generator<Op[]> {
  if (i === a.length && j === b.length) {
    yield acc;
    return;
  }
  if (i < a.length && j < b.length && a[i] === b[j]) {
    yield* allEditScripts(a, b, i + 1, j + 1, [...acc, { type: 'keep', line: a[i] }]);
  }
  if (i < a.length) yield* allEditScripts(a, b, i + 1, j, [...acc, { type: 'del', line: a[i] }]);
  if (j < b.length) yield* allEditScripts(a, b, i, j + 1, [...acc, { type: 'ins', line: b[j] }]);
}

function allStrings(alphabet: string[], maxLen: number): string[][] {
  const out: string[][] = [[]];
  let frontier: string[][] = [[]];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[][] = [];
    for (const s of frontier) for (const c of alphabet) next.push([...s, c]);
    out.push(...next);
    frontier = next;
  }
  return out;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('diff of identical documents is empty', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), []);
});

test('insertion, deletion and replacement hunks carry base line numbers', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'x', 'b']), [
    { baseStart: 1, baseEnd: 1, lines: ['x'] },
  ]);
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), [
    { baseStart: 1, baseEnd: 2, lines: [] },
  ]);
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']), [
    { baseStart: 1, baseEnd: 2, lines: ['B'] },
  ]);
});

test('short documents: diff matches brute-force enumeration of all edit combinations', () => {
  const strings = allStrings(['x', 'y'], 4);
  let pairs = 0;
  for (const a of strings) {
    for (const b of strings) {
      const ops = diffOps(a, b);
      assert.deepEqual(applyOps(a, ops), b, `script must transform ${JSON.stringify(a)} into ${JSON.stringify(b)}`);
      let min = Infinity;
      for (const script of allEditScripts(a, b)) min = Math.min(min, editCost(script));
      assert.equal(
        editCost(ops),
        min,
        `diff cost must be minimal for ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
      );
      pairs++;
    }
  }
  assert.equal(pairs, 961);
});

test('myers path agrees with exhaustive path on randomized inputs', () => {
  const rand = lcg(42);
  const alphabet = ['a', 'b', 'c', 'd'];
  const randomDoc = () => {
    const len = Math.floor(rand() * 15);
    return Array.from({ length: len }, () => alphabet[Math.floor(rand() * alphabet.length)]);
  };
  for (let iter = 0; iter < 500; iter++) {
    const a = randomDoc();
    const b = randomDoc();
    const mine = myersOps(a, b);
    const full = exhaustiveOps(a, b);
    assert.deepEqual(applyOps(a, mine), b, 'myers script must be valid');
    assert.equal(editCost(mine), editCost(full), `myers cost must be minimal (iter ${iter})`);
  }
});

test('myers handles empty sides', () => {
  assert.deepEqual(applyOps([], myersOps([], ['a', 'b'])), ['a', 'b']);
  assert.deepEqual(applyOps(['a', 'b'], myersOps(['a', 'b'], [])), []);
  assert.deepEqual(myersOps([], []), []);
});

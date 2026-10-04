import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionedArray, DiffInterval } from '../src/versioned-array.js';

test('half-open interval assignment and snapshots', () => {
  const arr = new VersionedArray(10, 0);
  assert.equal(arr.version, 0);
  assert.deepEqual(arr.toArray(), new Array(10).fill(0));

  const v1 = arr.set(2, 5, 7); // [2,5) -> 7
  assert.equal(v1, 1);
  assert.deepEqual(arr.toArray(), [0, 0, 7, 7, 7, 0, 0, 0, 0, 0]);

  const v2 = arr.set(0, 10, 1);
  assert.equal(v2, 2);
  assert.deepEqual(arr.toArray(), new Array(10).fill(1));

  // historical snapshots are preserved
  assert.deepEqual(arr.toArray(0), new Array(10).fill(0));
  assert.deepEqual(arr.toArray(1), [0, 0, 7, 7, 7, 0, 0, 0, 0, 0]);
  assert.deepEqual(arr.toArray(2), new Array(10).fill(1));

  // point reads at specific versions
  assert.equal(arr.get(3, 1), 7);
  assert.equal(arr.get(3, 2), 1);
  assert.equal(arr.get(0, 1), 0);
});

test('empty updates do not create new versions', () => {
  const arr = new VersionedArray(8, 3);
  assert.equal(arr.set(4, 4, 9), 0); // empty interval
  assert.equal(arr.set(0, 8, 3), 0); // same value everywhere
  assert.equal(arr.set(2, 6, 3), 0); // sub-range already holds the value
  assert.equal(arr.version, 0);

  assert.equal(arr.set(2, 6, 5), 1); // real change
  assert.equal(arr.set(2, 6, 5), 1); // repeat: no change, no new version
  assert.equal(arr.version, 1);
});

test('diff returns maximal contiguous differing intervals with before/after', () => {
  const arr = new VersionedArray(12, 0);
  arr.set(1, 4, 10); // v1
  arr.set(6, 8, 20); // v2
  arr.set(9, 11, -3); // v3

  assert.deepEqual(arr.diff(0, 3), [
    { start: 1, end: 4, before: 0, after: 10 },
    { start: 6, end: 8, before: 0, after: 20 },
    { start: 9, end: 11, before: 0, after: -3 },
  ] satisfies DiffInterval[]);

  // identical versions diff to nothing
  assert.deepEqual(arr.diff(2, 2), []);
  assert.deepEqual(arr.diff(0, 0), []);
});

test('diff merges adjacent positions with the same (before, after) pair', () => {
  const arr = new VersionedArray(10, 0);
  arr.set(2, 4, 5); // v1: [2,4) = 5
  arr.set(4, 6, 5); // v2: [4,6) = 5, so [2,6) uniformly 5
  arr.set(6, 8, 9); // v3

  // [2,6) all change 0 -> 5 and must merge into one maximal interval
  assert.deepEqual(arr.diff(0, 2), [{ start: 2, end: 6, before: 0, after: 5 }]);

  // different pairs are NOT merged even when adjacent
  assert.deepEqual(arr.diff(0, 3), [
    { start: 2, end: 6, before: 0, after: 5 },
    { start: 6, end: 8, before: 0, after: 9 },
  ]);

  // reverse direction swaps before/after
  assert.deepEqual(arr.diff(3, 0), [
    { start: 2, end: 6, before: 5, after: 0 },
    { start: 6, end: 8, before: 9, after: 0 },
  ]);
});

test('diff across non-adjacent versions', () => {
  const arr = new VersionedArray(6, 1);
  arr.set(0, 2, 8); // v1
  arr.set(2, 4, 8); // v2
  arr.set(4, 6, 8); // v3
  assert.deepEqual(arr.diff(0, 3), [{ start: 0, end: 6, before: 1, after: 8 }]);
  assert.deepEqual(arr.diff(1, 3), [{ start: 2, end: 6, before: 1, after: 8 }]);
});

test('invalid inputs are rejected', () => {
  const arr = new VersionedArray(5);
  assert.throws(() => arr.set(-1, 2, 1), RangeError);
  assert.throws(() => arr.set(3, 2, 1), RangeError);
  assert.throws(() => arr.set(0, 6, 1), RangeError);
  assert.throws(() => arr.set(0, 2, 1.5), RangeError);
  assert.throws(() => arr.toArray(3), RangeError);
  assert.throws(() => arr.get(5), RangeError);
});

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brute-force diff of two plain arrays, merging adjacent equal (before, after) pairs. */
function modelDiff(before: number[], after: number[]): DiffInterval[] {
  const out: DiffInterval[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    const last = out[out.length - 1];
    if (last && last.before === before[i] && last.after === after[i] && last.end === i) {
      last.end = i + 1;
    } else {
      out.push({ start: i, end: i + 1, before: before[i], after: after[i] });
    }
  }
  return out;
}

test('randomized updates cross-checked against a copied-array model', () => {
  const rand = mulberry32(20261005);
  const LENGTH = 60;
  const OPS = 2000;

  const arr = new VersionedArray(LENGTH, 0);
  const modelVersions: number[][] = [new Array(LENGTH).fill(0)];

  for (let op = 0; op < OPS; op++) {
    const a = Math.floor(rand() * (LENGTH + 1));
    const b = Math.floor(rand() * (LENGTH + 1));
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    // bias towards repeated values so no-op updates actually occur
    const value = Math.floor(rand() * 4) - 1;

    const before = arr.version;
    const after = arr.set(start, end, value);

    const model = modelVersions[modelVersions.length - 1].slice();
    model.fill(value, start, end);

    if (after === before) {
      // empty update: no new version, and the model must be unchanged
      assert.deepEqual(model, modelVersions[before], `op ${op}: no-op update changed the model`);
    } else {
      assert.equal(after, before + 1, `op ${op}: version must increase by exactly 1`);
      modelVersions.push(model);
    }

    // spot-check the latest version against the model
    assert.deepEqual(arr.toArray(after), model, `op ${op}: latest version mismatch`);
  }

  // full history check: every version matches its model snapshot
  assert.equal(arr.version, modelVersions.length - 1);
  for (let v = 0; v <= arr.version; v++) {
    assert.deepEqual(arr.toArray(v), modelVersions[v], `version ${v} mismatch`);
  }

  // random version-pair diffs match the brute-force model diff
  for (let k = 0; k < 500; k++) {
    const from = Math.floor(rand() * (arr.version + 1));
    const to = Math.floor(rand() * (arr.version + 1));
    assert.deepEqual(
      arr.diff(from, to),
      modelDiff(modelVersions[from], modelVersions[to]),
      `diff(${from}, ${to}) mismatch`,
    );
  }
});

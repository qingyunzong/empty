import { test } from "node:test";
import assert from "node:assert/strict";
import { VersionedArray, type DiffInterval } from "../src/versioned-array.js";

test("half-open range assignment and snapshots", () => {
  const arr = new VersionedArray(6, 0);
  assert.equal(arr.version, 0);

  const v1 = arr.setRange(1, 4, 7); // [1, 4)
  assert.equal(v1, 1);
  assert.deepEqual(arr.snapshot(), [0, 7, 7, 7, 0, 0]);
  assert.deepEqual(arr.snapshot(0), [0, 0, 0, 0, 0, 0]); // history kept

  arr.setRange(0, 6, 1);
  assert.deepEqual(arr.snapshot(2), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(arr.snapshot(1), [0, 7, 7, 7, 0, 0]); // older snapshot intact
  assert.equal(arr.at(3, 1), 7);
  assert.equal(arr.at(3, 2), 1);
});

test("empty updates do not bump the version", () => {
  const arr = new VersionedArray(4, 5);
  assert.equal(arr.setRange(2, 2, 9), 0); // empty range
  assert.equal(arr.setRange(0, 0, 1), 0); // empty range
  assert.equal(arr.setRange(0, 4, 5), 0); // nothing changes
  assert.equal(arr.version, 0);

  assert.equal(arr.setRange(1, 3, 8), 1);
  assert.equal(arr.setRange(1, 3, 8), 1); // same value again: no bump
  assert.equal(arr.version, 1);
  assert.deepEqual(arr.snapshot(), [5, 8, 8, 5]);
});

test("diff returns maximal contiguous intervals with before/after values", () => {
  const arr = new VersionedArray(8, 0);
  arr.setRange(1, 3, 4); // v1
  arr.setRange(5, 6, 2); // v2
  const diff = arr.diff(0, 2);
  assert.deepEqual(diff, [
    { start: 1, end: 3, before: [0, 0], after: [4, 4] },
    { start: 5, end: 6, before: [0], after: [2] },
  ]);
  assert.deepEqual(arr.diff(1, 1), []); // identical versions
});

test("diff merges adjacent positions with the same delta only", () => {
  const arr = new VersionedArray(6, 10);
  // indices: 0:+1 1:+1 2:+2 3:+1 4:+1 -> runs [0,2) d=1, [2,3) d=2, [3,5) d=1
  arr.setRange(0, 2, 11);
  arr.setRange(2, 3, 12);
  arr.setRange(3, 5, 11);
  const diff = arr.diff(0, arr.version);
  assert.deepEqual(diff, [
    { start: 0, end: 2, before: [10, 10], after: [11, 11] },
    { start: 2, end: 3, before: [10], after: [12] },
    { start: 3, end: 5, before: [10, 10], after: [11, 11] },
  ]);
});

test("invalid arguments throw", () => {
  const arr = new VersionedArray(4);
  assert.throws(() => arr.setRange(-1, 2, 1), RangeError);
  assert.throws(() => arr.setRange(0, 5, 1), RangeError);
  assert.throws(() => arr.setRange(3, 1, 1), RangeError);
  assert.throws(() => arr.setRange(0, 2, 1.5), TypeError);
  assert.throws(() => arr.snapshot(9), RangeError);
});

// --- Randomized model-based test -------------------------------------------

/** Seeded PRNG (mulberry32) for reproducible runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent naive diff over plain-array model snapshots. */
function modelDiff(before: number[], after: number[]): DiffInterval[] {
  const out: DiffInterval[] = [];
  let i = 0;
  while (i < before.length) {
    if (before[i] === after[i]) {
      i++;
      continue;
    }
    const delta = after[i] - before[i];
    const start = i;
    i++;
    while (i < before.length && before[i] !== after[i] && after[i] - before[i] === delta) i++;
    out.push({ start, end: i, before: before.slice(start, i), after: after.slice(start, i) });
  }
  return out;
}

test("randomized updates match a copied plain-array model", () => {
  const random = rng(20261005);
  const LENGTH = 40;
  const OPS = 500;

  const arr = new VersionedArray(LENGTH, 0);
  const model = new Array<number>(LENGTH).fill(0);
  const modelSnapshots: number[][] = [model.slice()];

  for (let op = 0; op < OPS; op++) {
    const a = Math.floor(random() * (LENGTH + 2)) - 1; // may be -1..LENGTH
    const b = Math.floor(random() * (LENGTH + 2)) - 1;
    const start = Math.max(0, Math.min(a, b));
    const end = Math.max(0, Math.min(Math.max(a, b), LENGTH)); // clamp, may equal start
    const value = Math.floor(random() * 5) - 2; // small value set -> frequent no-ops

    const versionBefore = arr.version;
    const versionAfter = arr.setRange(start, end, value);

    // Apply to the model.
    let changed = false;
    for (let i = start; i < end; i++) {
      if (model[i] !== value) changed = true;
      model[i] = value;
    }
    if (changed) modelSnapshots.push(model.slice());

    // Version bookkeeping: bump iff the update was non-empty.
    assert.equal(versionAfter, changed ? versionBefore + 1 : versionBefore);
    assert.equal(arr.version, modelSnapshots.length - 1);
    // State matches the model at every step.
    assert.deepEqual(arr.snapshot(), model);
  }

  // Every historical snapshot matches the corresponding model snapshot.
  for (let v = 0; v <= arr.version; v++) {
    assert.deepEqual(arr.snapshot(v), modelSnapshots[v], `snapshot mismatch at version ${v}`);
  }

  // Diff between random version pairs matches the naive model diff.
  for (let k = 0; k < 200; k++) {
    const from = Math.floor(random() * (arr.version + 1));
    const to = Math.floor(random() * (arr.version + 1));
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    assert.deepEqual(arr.diff(lo, hi), modelDiff(modelSnapshots[lo], modelSnapshots[hi]));
  }
});

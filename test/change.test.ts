import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, type Op, type State } from '../src/change.js';
import { compress } from '../src/compress.js';
import { invert, BaselineRequiredError } from '../src/invert.js';

// ---------- unit tests: compression rules ----------

test('insert then delete on same key disappears', () => {
  const { ops, missingBaseline } = compress([
    { kind: 'insert', key: 'a', value: 1 },
    { kind: 'delete', key: 'a', oldValue: 1 },
  ]);
  assert.deepEqual(ops, []);
  assert.deepEqual(missingBaseline, []);
});

test('delete then insert becomes replace and keeps the original value', () => {
  const { ops, missingBaseline } = compress([
    { kind: 'delete', key: 'a', oldValue: 'old' },
    { kind: 'insert', key: 'a', value: 'new' },
  ]);
  assert.deepEqual(ops, [
    { kind: 'replace', key: 'a', oldValue: 'old', value: 'new' },
  ]);
  assert.deepEqual(missingBaseline, []);
});

test('unknown original value is reported as needing a baseline', () => {
  const { ops, missingBaseline } = compress([
    { kind: 'delete', key: 'a' }, // no oldValue recorded
    { kind: 'insert', key: 'a', value: 9 },
  ]);
  assert.deepEqual(ops, [{ kind: 'replace', key: 'a', oldValue: undefined, value: 9 }]);
  assert.deepEqual(missingBaseline, ['a']);
  assert.throws(() => invert(ops), BaselineRequiredError);
  try {
    invert(ops);
    assert.fail('invert should have thrown');
  } catch (err) {
    if (!(err instanceof BaselineRequiredError)) throw err;
    assert.deepEqual(err.keys, ['a']);
  }
});

test('insert then replace collapses to a single insert', () => {
  const { ops } = compress([
    { kind: 'insert', key: 'a', value: 1 },
    { kind: 'replace', key: 'a', oldValue: 1, value: 2 },
  ]);
  assert.deepEqual(ops, [{ kind: 'insert', key: 'a', value: 2 }]);
});

test('replace chain keeps first oldValue and final value', () => {
  const { ops } = compress([
    { kind: 'replace', key: 'a', oldValue: 1, value: 2 },
    { kind: 'replace', key: 'a', oldValue: 2, value: 3 },
    { kind: 'replace', key: 'a', oldValue: 3, value: 4 },
  ]);
  assert.deepEqual(ops, [{ kind: 'replace', key: 'a', oldValue: 1, value: 4 }]);
});

test('replace then delete becomes delete with the original value', () => {
  const { ops } = compress([
    { kind: 'replace', key: 'a', oldValue: 1, value: 2 },
    { kind: 'delete', key: 'a', oldValue: 2 },
  ]);
  assert.deepEqual(ops, [{ kind: 'delete', key: 'a', oldValue: 1 }]);
});

test('only consecutive same-key runs are compressed', () => {
  const { ops } = compress([
    { kind: 'insert', key: 'a', value: 1 },
    { kind: 'insert', key: 'b', value: 2 },
    { kind: 'delete', key: 'a', oldValue: 1 },
  ]);
  assert.equal(ops.length, 3);
});

// ---------- unit tests: inverse batches ----------

test('inverse batch undoes a batch in reverse order', () => {
  const initial: State = new Map([['x', 10]]);
  const ops: Op[] = [
    { kind: 'replace', key: 'x', oldValue: 10, value: 11 },
    { kind: 'insert', key: 'y', value: 'hi' },
    { kind: 'insert', key: 'z', value: true },
    { kind: 'delete', key: 'z', oldValue: true },
  ];
  const after = applyOps(initial, ops);
  const restored = applyOps(after, invert(ops));
  assert.deepEqual(restored, initial);
});

// ---------- property test: random ops ----------

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

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'];

function randomValue(rand: () => number): unknown {
  const r = rand();
  if (r < 0.5) return Math.floor(rand() * 1000);
  if (r < 0.8) return `v${Math.floor(rand() * 1000)}`;
  return rand() < 0.5;
}

/** Generate a random valid op sequence, recording real old values. */
function randomOps(rand: () => number, state: State, count: number): Op[] {
  const ops: Op[] = [];
  const work: State = new Map(state);
  for (let i = 0; i < count; i++) {
    const key = KEYS[Math.floor(rand() * KEYS.length)]!;
    const exists = work.has(key);
    const choice = rand();
    if (!exists || choice < 0.4) {
      if (exists) {
        const oldValue = work.get(key);
        const value = randomValue(rand);
        ops.push({ kind: 'replace', key, oldValue, value });
        work.set(key, value);
      } else {
        const value = randomValue(rand);
        ops.push({ kind: 'insert', key, value });
        work.set(key, value);
      }
    } else if (choice < 0.7) {
      const oldValue = work.get(key);
      ops.push({ kind: 'delete', key, oldValue });
      work.delete(key);
    } else {
      const oldValue = work.get(key);
      const value = randomValue(rand);
      ops.push({ kind: 'replace', key, oldValue, value });
      work.set(key, value);
    }
  }
  return ops;
}

test('random ops: compression preserves result and undo restores state', () => {
  const ITERATIONS = 500;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const rand = mulberry32(iter * 2654435761 + 1);
    const initial: State = new Map();
    for (const key of KEYS) {
      if (rand() < 0.5) initial.set(key, randomValue(rand));
    }
    const ops = randomOps(rand, initial, 1 + Math.floor(rand() * 30));

    const { ops: compressed, missingBaseline } = compress(ops);
    assert.deepEqual(missingBaseline, [], 'all old values were recorded');
    assert.ok(compressed.length <= ops.length, 'compression never grows the batch');

    // Same result before and after compression.
    const viaOriginal = applyOps(initial, ops);
    const viaCompressed = applyOps(initial, compressed);
    assert.deepEqual(viaCompressed, viaOriginal, `iteration ${iter}: forward mismatch`);

    // Undo of both batches restores the initial state.
    assert.deepEqual(applyOps(viaOriginal, invert(ops)), initial, `iteration ${iter}: undo original`);
    assert.deepEqual(applyOps(viaCompressed, invert(compressed)), initial, `iteration ${iter}: undo compressed`);
  }
});

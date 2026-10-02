// Acceptance scenario 3: random mixed serializable / non-serializable
// histories, checked against a brute-force oracle that enumerates every
// serial permutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSerializable,
  bruteForceSerializable,
  replayState,
  statesEqual,
} from '../src/serialize.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['a', 'b', 'c', 'd'];

// Generates a random history. Half of the cases are produced by simulating a
// random serial execution (serializable by construction); the other half use
// arbitrary read values and a final state from a random permutation (mixed).
function genHistory(rng) {
  const n = 2 + Math.floor(rng() * 6); // 2..7 transactions
  const txns = [];
  let vc = 0;
  const pickKey = () => KEYS[Math.floor(rng() * KEYS.length)];
  const serializableCase = rng() < 0.5;

  if (serializableCase) {
    const state = {};
    for (let i = 0; i < n; i++) {
      const reads = {};
      const writes = {};
      const nr = Math.floor(rng() * 3);
      for (let j = 0; j < nr; j++) {
        const k = pickKey();
        reads[k] = state[k] ?? null;
      }
      const nw = 1 + Math.floor(rng() * 2);
      for (let j = 0; j < nw; j++) writes[pickKey()] = 'v' + vc++;
      txns.push({ id: 'T' + i, clock: {}, parents: [], reads, writes });
      Object.assign(state, writes);
    }
    return { txns, finalState: state };
  }

  // Arbitrary case: random writes with unique values, reads pick null or an
  // existing writer's value, final state from a random permutation replay.
  for (let i = 0; i < n; i++) {
    const writes = {};
    const nw = 1 + Math.floor(rng() * 2);
    for (let j = 0; j < nw; j++) writes[pickKey()] = 'v' + vc++;
    txns.push({ id: 'T' + i, clock: {}, parents: [], reads: {}, writes });
  }
  for (const t of txns) {
    const nr = Math.floor(rng() * 3);
    for (let j = 0; j < nr; j++) {
      const k = pickKey();
      const writers = txns.filter((o) => o.id !== t.id && k in o.writes);
      if (writers.length && rng() < 0.7) {
        t.reads[k] = writers[Math.floor(rng() * writers.length)].writes[k];
      } else {
        t.reads[k] = null;
      }
    }
  }
  const perm = [...txns].sort(() => rng() - 0.5);
  const finalState = replayState(txns, perm.map((t) => t.id));
  return { txns, finalState };
}

test('random mixed histories: checker agrees with brute-force oracle', () => {
  const rng = mulberry32(20261003);
  const N = 400;
  let serializableCount = 0;
  let nonSerializableCount = 0;
  for (let iter = 0; iter < N; iter++) {
    const { txns, finalState } = genHistory(rng);
    const expected = bruteForceSerializable(txns, finalState);
    const res = checkSerializable(txns, finalState);
    assert.equal(
      res.serializable,
      expected,
      `iteration ${iter}: checker=${res.serializable} oracle=${expected} ` +
        `txns=${JSON.stringify(txns)} final=${JSON.stringify(finalState)}`,
    );
    if (res.serializable) {
      serializableCount++;
      // the emitted serial order must reproduce the final state
      assert.ok(statesEqual(replayState(txns, res.order), finalState));
      assert.equal(res.consistent, true);
      assert.equal(res.order.length, txns.length);
    } else {
      nonSerializableCount++;
      // a conflict cycle witness is reported whenever a cycle exists in the
      // constraint graph (unmatched-read/final-value rejections have none)
      if (res.cycle) {
        assert.equal(res.cycle[0], res.cycle[res.cycle.length - 1]);
        const ids = new Set(txns.map((t) => t.id));
        for (const id of res.cycle) assert.ok(ids.has(id));
      }
    }
  }
  console.log(
    `random histories: ${serializableCount} serializable, ` +
      `${nonSerializableCount} non-serializable (of ${N})`,
  );
  // sanity: the generator really produces a mix
  assert.ok(serializableCount > 0);
  assert.ok(nonSerializableCount > 0);
});

test('hand-built serializable chain: order respects read-from', () => {
  const txns = [
    { id: 'T1', clock: {}, parents: [], reads: {}, writes: { x: '1' } },
    { id: 'T2', clock: {}, parents: [], reads: { x: '1' }, writes: { y: '2' } },
    { id: 'T3', clock: {}, parents: [], reads: { y: '2', x: '1' }, writes: { x: '3' } },
  ];
  const finalState = { x: '3', y: '2' };
  const res = checkSerializable(txns, finalState);
  assert.equal(res.serializable, true);
  assert.deepEqual(res.order, ['T1', 'T2', 'T3']);
  assert.equal(bruteForceSerializable(txns, finalState), true);
});

test('hand-built read-from cycle is detected with a cycle witness', () => {
  // T1 reads what T2 wrote, T2 reads what T1 wrote: impossible serially.
  const txns = [
    { id: 'T1', clock: {}, parents: [], reads: { y: 'b' }, writes: { x: 'a' } },
    { id: 'T2', clock: {}, parents: [], reads: { x: 'a' }, writes: { y: 'b' } },
  ];
  const finalState = { x: 'a', y: 'b' };
  const res = checkSerializable(txns, finalState);
  assert.equal(res.serializable, false);
  assert.deepEqual(new Set(res.cycle), new Set(['T1', 'T2']));
  assert.equal(bruteForceSerializable(txns, finalState), false);
});

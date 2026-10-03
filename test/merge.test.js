import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocalOps,
  mergeEvents,
  mergeFromStore,
  readEvents,
  status,
} from '../src/store.js';
import { freshStore, permutations } from './helpers.js';

function setupThreeWayConcurrentCorrections() {
  const nodes = ['A', 'B', 'C'];
  const dirA = freshStore('A', nodes);
  const dirB = freshStore('B', nodes);
  const dirC = freshStore('C', nodes);

  // Shared base value, created on A and delivered to B and C.
  applyLocalOps(dirA, [{ kind: 'put', key: 'sample-1', value: { reading: 0 } }]);
  mergeFromStore(dirB, dirA);
  mergeFromStore(dirC, dirA);

  // Three concurrent corrections, one per node, none aware of the others.
  applyLocalOps(dirA, [{ kind: 'correct', key: 'sample-1', value: { reading: 'A' } }]);
  applyLocalOps(dirB, [{ kind: 'correct', key: 'sample-1', value: { reading: 'B' } }]);
  applyLocalOps(dirC, [{ kind: 'correct', key: 'sample-1', value: { reading: 'C' } }]);

  return { dirA, dirB, dirC };
}

test('acceptance 1: three-way concurrent correction merge matches all-permutation reference', () => {
  const { dirA, dirB, dirC } = setupThreeWayConcurrentCorrections();

  // Full merge of all three replicas.
  const merged = freshStore('M');
  mergeFromStore(merged, dirA);
  mergeFromStore(merged, dirB);
  mergeFromStore(merged, dirC);
  const expected = status(merged).records;
  assert.equal(Object.keys(expected).length, 1);

  // Reference: enumerate every permutation of the full event set, deliver
  // events one by one into a fresh store, and require identical visible state.
  const streams = [dirA, dirB, dirC].map((d) => readEvents(d));
  const all = streams.flat();
  const perms = permutations(all);
  assert.ok(perms.length > 100, 'reference must enumerate many permutations');
  for (const deliveryOrder of perms) {
    const ref = freshStore('R');
    for (const e of deliveryOrder) mergeEvents(ref, [e]);
    assert.deepEqual(
      status(ref).records,
      expected,
      `permutation diverged: ${deliveryOrder.map((e) => e.id).join(',')}`,
    );
  }

  // The deterministic winner is the max by (lamport, node, id): no wall clock.
  const winner = Object.values(expected)[0];
  const corrections = streams.flat().filter((e) => e.kind === 'correct');
  const maxByRank = corrections.reduce((a, b) => {
    if (a.lamport !== b.lamport) return a.lamport > b.lamport ? a : b;
    if (a.node !== b.node) return a.node > b.node ? a : b;
    return a.id > b.id ? a : b;
  });
  assert.equal(winner.id, maxByRank.id);
});

test('merge is associative at store level', () => {
  const { dirA, dirB, dirC } = setupThreeWayConcurrentCorrections();

  const left = freshStore('L'); // (A+B)+C
  mergeFromStore(left, dirA);
  mergeFromStore(left, dirB);
  mergeFromStore(left, dirC);

  const right = freshStore('R'); // A+(B+C)
  const bc = freshStore('X');
  mergeFromStore(bc, dirB);
  mergeFromStore(bc, dirC);
  mergeFromStore(right, dirA);
  mergeFromStore(right, bc);

  assert.deepEqual(status(left).records, status(right).records);
  assert.deepEqual(status(left).frontier, status(right).frontier);
});

test('acceptance 3: duplicate and out-of-order delivery is idempotent', () => {
  const src = freshStore('S');
  const [e1] = applyLocalOps(src, [{ kind: 'put', key: 'k1', value: 1 }]);
  const [e2] = applyLocalOps(src, [{ kind: 'correct', key: 'k1', value: 2 }]);
  const [e3] = applyLocalOps(src, [{ kind: 'correct', key: 'k1', value: 3 }]);

  const dst = freshStore('D');
  // Out of order, with duplicates and re-delivery of the whole stream.
  mergeEvents(dst, [e3]);
  mergeEvents(dst, [e1]);
  mergeEvents(dst, [e2, e2]);
  const r1 = mergeEvents(dst, [e1, e2, e3]);
  const r2 = mergeEvents(dst, [e3, e2, e1]);
  assert.equal(r1.merged, 0);
  assert.equal(r1.skipped, 3);
  assert.equal(r2.merged, 0);

  const st = status(dst);
  assert.equal(st.eventCount, 3);
  assert.deepEqual(st.records.k1.value, 3);
  assert.deepEqual(st.frontier, { S: 3 });

  // Repeating the entire merge changes nothing.
  const before = status(dst);
  mergeFromStore(dst, src);
  mergeFromStore(dst, src);
  assert.deepEqual(status(dst), before);
});

test('mergeEvents rejects malformed events with INVALID_INPUT', () => {
  const dst = freshStore('D');
  assert.throws(() => mergeEvents(dst, [{ id: 'x:1' }]), /missing field/);
  assert.throws(() => mergeEvents(dst, ['nope']), /JSON object/);
});

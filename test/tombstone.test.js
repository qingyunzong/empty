import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocalOps,
  compactStore,
  mergeEvents,
  mergeFromStore,
  readEvents,
  status,
} from '../src/store.js';
import { freshStore } from './helpers.js';

function setupCluster() {
  const nodes = ['A', 'B', 'C'];
  return {
    A: freshStore('A', nodes),
    B: freshStore('B', nodes),
    C: freshStore('C', nodes),
  };
}

test('acceptance 2: deleted old value cannot resurrect via late or duplicate delivery', () => {
  const { A, B } = setupCluster();
  const [put] = applyLocalOps(A, [{ kind: 'put', key: 'k', value: 'old' }]);
  const [del] = applyLocalOps(A, [{ kind: 'delete', key: 'k' }]);

  // Out-of-order and duplicate delivery into B: tombstone first, then old put.
  mergeEvents(B, [del]);
  mergeEvents(B, [put]);
  mergeEvents(B, [put, del]);
  const st = status(B);
  assert.deepEqual(st.records, {});
  assert.equal(st.tombstones.length, 1);
  assert.equal(st.tombstones[0].key, 'k');

  // A put that causally follows the delete is a new value and is visible.
  mergeFromStore(B, A);
  const [re] = applyLocalOps(B, [{ kind: 'put', key: 'k', value: 'new' }]);
  mergeEvents(A, [re]);
  assert.deepEqual(status(A).records.k.value, 'new');
});

test('acceptance 2: compaction preserves visible state and blocks resurrection', () => {
  const { A, B, C } = setupCluster();
  applyLocalOps(A, [
    { kind: 'put', key: 'gone', value: 1 },
    { kind: 'put', key: 'kept', value: 2 },
  ]);
  applyLocalOps(A, [{ kind: 'correct', key: 'kept', value: 3 }]);
  const [del] = applyLocalOps(A, [{ kind: 'delete', key: 'gone' }]);
  const oldPut = readEvents(A).find((e) => e.key === 'gone' && e.kind === 'put');

  // Everyone sees the delete; B and C report their knowledge back to A.
  mergeFromStore(B, A);
  mergeFromStore(C, A);
  mergeFromStore(A, B);
  mergeFromStore(A, C);

  const before = status(A);
  assert.equal(before.tombstones.length, 1);

  const result = compactStore(A, { now: del.ts + 60000, retentionMs: 1000 });
  assert.ok(result.removed >= 2, 'tombstone and covered put are compacted');
  assert.deepEqual(result.compactedKeys, ['gone']);

  const after = status(A);
  assert.deepEqual(after.records, before.records, 'visible records unchanged by compaction');
  assert.equal(after.tombstones.length, 0);
  assert.ok(after.eventCount < before.eventCount);

  // Re-delivery of the covered old put must not resurrect the key.
  mergeEvents(A, [oldPut]);
  assert.deepEqual(status(A).records, before.records);
});

test('compaction is refused until every node has seen the tombstone', () => {
  const { A, B, C } = setupCluster();
  applyLocalOps(A, [{ kind: 'put', key: 'k', value: 1 }]);
  const [del] = applyLocalOps(A, [{ kind: 'delete', key: 'k' }]);

  // Only B learns about the delete; C never reports back.
  mergeFromStore(B, A);
  mergeFromStore(A, B);

  const result = compactStore(A, { now: del.ts + 10000000, retentionMs: 0 });
  assert.equal(result.removed, 0);
  assert.equal(status(A).tombstones.length, 1, 'tombstone retained: C has not seen it');

  // Once C has seen it and reported back, compaction proceeds.
  mergeFromStore(C, A);
  mergeFromStore(A, C);
  const result2 = compactStore(A, { now: del.ts + 10000000, retentionMs: 0 });
  assert.ok(result2.removed >= 2);
  assert.equal(status(A).tombstones.length, 0);
});

test('compaction respects the parameterized retention period', () => {
  const A = freshStore('A', ['A', 'B']);
  const B = freshStore('B', ['A', 'B']);
  applyLocalOps(A, [{ kind: 'put', key: 'k', value: 1 }]);
  const [del] = applyLocalOps(A, [{ kind: 'delete', key: 'k' }]);
  mergeFromStore(B, A);
  mergeFromStore(A, B);

  // All nodes have seen it, but the retention period has not elapsed.
  const early = compactStore(A, { now: del.ts + 500, retentionMs: 60000 });
  assert.equal(early.removed, 0);
  assert.equal(status(A).tombstones.length, 1);

  const late = compactStore(A, { now: del.ts + 61000, retentionMs: 60000 });
  assert.ok(late.removed >= 2);
  assert.equal(status(A).tombstones.length, 0);
});

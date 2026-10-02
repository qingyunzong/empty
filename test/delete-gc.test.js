import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, doOp, doMerge, dump, visible, summary } from './helpers.js';

const NODES = ['A', 'B'];

test('acceptance 2: tombstone prevents resurrection; compaction preserves visible state', () => {
  const dA = makeStore(NODES, { node: 'A' });
  const dB = makeStore(NODES, { node: 'B' });

  doOp(dA, 'put', [{ key: 'k1', value: 'v1' }, { key: 'k2', value: 'keep' }]);
  doMerge(dB, dump(dA));

  doOp(dA, 'delete', [{ key: 'k1' }]);
  assert.deepEqual(visible(dA), { k2: 'keep' });
  assert.equal(summary(dA).tombstones, 1);

  // B still holds the pre-delete value; replaying it into A must not resurrect k1.
  assert.equal(visible(dB).k1, 'v1');
  doMerge(dA, dump(dB));
  assert.equal(visible(dA).k1, undefined, 'deleted value must not resurrect');
  assert.equal(summary(dA).tombstones, 1, 'B has not acknowledged the delete yet: no compaction');

  // B learns the tombstone, then advances its own clock.
  doMerge(dB, dump(dA));
  assert.equal(visible(dB).k1, undefined);
  doOp(dB, 'put', [{ key: 'other', value: 'x' }]);

  // Once B's frontier (including the delete) reaches A, all nodes are proven
  // to have seen the tombstone and the next merge compacts it.
  const visibleBefore = visible(dA);
  doMerge(dA, dump(dB));
  assert.equal(summary(dA).tombstones, 0, 'tombstone compacted after all nodes saw it');
  assert.deepEqual(visible(dA), { ...visibleBefore, other: 'x' }, 'compaction must not change visible state');
  assert.equal(visible(dA).k1, undefined);

  // The deletion itself remains on record in the audit log (prepare/commit lines).
  doMerge(dB, dump(dA)); // symmetric convergence
  assert.deepEqual(visible(dB), visible(dA));
});

test('retention parameter delays compaction until the lamport age elapses', () => {
  const dA = makeStore(NODES, { node: 'A', retention: 2 });
  const dB = makeStore(NODES, { node: 'B', retention: 2 });

  doOp(dA, 'put', [{ key: 'k', value: 'v' }]);
  doMerge(dB, dump(dA));
  doOp(dA, 'delete', [{ key: 'k' }]);
  doMerge(dB, dump(dA));
  doOp(dB, 'put', [{ key: 'x', value: 1 }]);

  // All nodes have seen the delete, but lamport age (1) < retention (2).
  doMerge(dA, dump(dB));
  assert.equal(summary(dA).tombstones, 1, 'retention not yet elapsed: tombstone kept');

  // Advance the local lamport clock past the retention window; an (empty)
  // merge re-evaluates GC and compacts.
  doOp(dA, 'put', [{ key: 'y', value: 2 }]);
  const before = visible(dA);
  doMerge(dA, []);
  assert.equal(summary(dA).tombstones, 0, 'tombstone compacted once retention elapsed');
  assert.deepEqual(visible(dA), before);
});

test('delete leaves a trace: tombstone version stays in history until GC', () => {
  const dA = makeStore(NODES, { node: 'A' });
  doOp(dA, 'put', [{ key: 'k', value: 'v1' }]);
  doOp(dA, 'correct', [{ key: 'k', value: 'v2' }]);
  doOp(dA, 'delete', [{ key: 'k' }]);
  const rec = dump(dA).find((l) => l.type === 'record').record;
  assert.equal(rec.deleted, true);
  assert.equal(rec.value, null);
  assert.deepEqual(rec.history.map((v) => v.value), ['v1', 'v2', null]);
  assert.deepEqual(rec.history.map((v) => v.deleted), [false, false, true]);
});

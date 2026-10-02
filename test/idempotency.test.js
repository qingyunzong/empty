import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, doOp, doMerge, dump, visible, canonical, canonicalLive } from './helpers.js';

const NODES = ['A', 'B', 'C'];

test('acceptance 3: duplicate and out-of-order delivery is idempotent', () => {
  const dA = makeStore(NODES, { node: 'A' });
  doOp(dA, 'put', [{ key: 'k', value: 'v1' }]);
  const dump1 = dump(dA);
  doOp(dA, 'correct', [{ key: 'k', value: 'v2' }]);
  const dump2 = dump(dA);

  // Out of order with duplicates across deliveries.
  const dB = makeStore(NODES, { node: 'B' });
  doMerge(dB, dump2);
  doMerge(dB, dump1);
  doMerge(dB, dump2);
  doMerge(dB, dump1);

  // In order, exactly once.
  const dC = makeStore(NODES, { node: 'C' });
  doMerge(dC, dump1);
  doMerge(dC, dump2);

  assert.deepEqual(canonical(dB), canonical(dC));
  assert.equal(visible(dB).k, 'v2');

  // Duplicated lines inside a single merge input are absorbed too.
  const dD = makeStore([...NODES, 'D'], { node: 'D' });
  doMerge(dD, [...dump2, ...dump2, ...dump1]);
  assert.deepEqual(visible(dD), visible(dC));
  const recD = canonical(dD).records;
  const recC = canonical(dC).records;
  assert.deepEqual(recD, recC);
});

test('concurrent replicas converge to identical state after full gossip', () => {
  const dA = makeStore(NODES, { node: 'A' });
  const dB = makeStore(NODES, { node: 'B' });
  const dC = makeStore(NODES, { node: 'C' });

  doOp(dA, 'put', [{ key: 's1', value: 'a1' }, { key: 's2', value: 'a2' }]);
  doOp(dB, 'put', [{ key: 's3', value: 'b3' }]);
  doOp(dC, 'put', [{ key: 's1', value: 'c1' }]); // concurrent with A's s1
  doOp(dA, 'correct', [{ key: 's2', value: 'a2-fixed' }]);
  doOp(dB, 'delete', [{ key: 's3' }]);

  // Gossip in different orders per receiver, with repeats.
  doMerge(dA, dump(dB));
  doMerge(dA, dump(dC));
  doMerge(dB, dump(dC));
  doMerge(dB, dump(dA));
  doMerge(dC, dump(dA));
  doMerge(dC, dump(dB));
  // Second round so deletes/acks propagate everywhere.
  doMerge(dA, dump(dB));
  doMerge(dB, dump(dC));
  doMerge(dC, dump(dA));

  // Visible state converges everywhere; tombstone compaction is local, so
  // compare the live records canonically and the visible state directly.
  assert.deepEqual(visible(dA), visible(dB));
  assert.deepEqual(visible(dB), visible(dC));
  assert.deepEqual(canonicalLive(dA), canonicalLive(dB));
  assert.deepEqual(canonicalLive(dB), canonicalLive(dC));
  assert.deepEqual(visible(dA), { s1: 'c1', s2: 'a2-fixed' }); // s1: lamport tie, origin 'C' > 'A'
});

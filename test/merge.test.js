'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { tmpdir } = require('./helpers');

// Acceptance scenario 1: two non-conflicting replicas merge cleanly.
test('scenario 1: non-conflicting replicas merge, check passes, state correct', () => {
  const dA = tmpdir();
  const dB = tmpdir();
  const a = Store.open(dA, { node: 'A' });
  const b = Store.open(dB, { node: 'B' });

  a.commit({ writes: { alice: '100' } });
  a.commit({ reads: ['alice'], writes: { alice: '150' } });
  b.commit({ writes: { bob: '50' } });

  // exchange segments both ways
  const segA = a.exportSegment();
  const segB = b.exportSegment();
  assert.equal(b.importSegment(segA).status, 'OK');
  assert.equal(a.importSegment(segB).status, 'OK');

  for (const s of [a, b]) {
    const res = s.check();
    assert.equal(res.status, 'SERIALIZABLE');
    assert.deepEqual(res.state, { alice: '150', bob: '50' });
    assert.equal(res.order.length, 3);
  }
  // both replicas converge to the same equivalent serial history
  assert.deepEqual(a.check().order, b.check().order);
});

// Acceptance scenario 2: cross read/write on the same keys -> cycle.
test('scenario 2: cross read-write history is NON_SERIALIZABLE with a real cycle', () => {
  const dA = tmpdir();
  const dB = tmpdir();
  const a = Store.open(dA, { node: 'A' });
  const b = Store.open(dB, { node: 'B' });

  // A: reads y (absent locally), writes x=1
  const tA = a.commit({ reads: ['y'], writes: { x: '1' } });
  // B: reads x (absent locally), writes y=1
  const tB = b.commit({ reads: ['x'], writes: { y: '1' } });

  b.importSegment(a.exportSegment());
  a.importSegment(b.exportSegment());

  const res = a.check();
  assert.equal(res.status, 'NON_SERIALIZABLE');
  assert.ok(Array.isArray(res.cycle));
  // cycle is closed and involves both transactions
  assert.equal(res.cycle[0], res.cycle[res.cycle.length - 1]);
  const members = new Set(res.cycle);
  assert.ok(members.has(tA.id));
  assert.ok(members.has(tB.id));
  // every transaction named in the cycle exists in the merged history
  for (const id of members) assert.ok(a.txns.has(id), `cycle txn ${id} exists`);
  // both replicas reach the same verdict
  assert.equal(b.check().status, 'NON_SERIALIZABLE');
});

test('causally dependent cross-replica history stays serializable', () => {
  const dA = tmpdir();
  const dB = tmpdir();
  const a = Store.open(dA, { node: 'A' });
  a.commit({ writes: { x: '1' } });
  const b = Store.open(dB, { node: 'B' });
  b.importSegment(a.exportSegment()); // B syncs first -> causal edge
  b.commit({ reads: ['x'], writes: { y: '2' } }); // reads x=1
  a.importSegment(b.exportSegment());
  const res = a.check();
  assert.equal(res.status, 'SERIALIZABLE');
  assert.deepEqual(res.state, { x: '1', y: '2' });
});

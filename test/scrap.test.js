'use strict';
// Acceptance 3: after a scrap tombstone, newly added splits do not revive
// the old risk, and upstream evidence is preserved. The tombstone blocks
// every outgoing edge (state semantics), but never erases the verdict of
// the scrapped batch itself or anything upstream of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const lineage = require('../src/lineage');

const EVENTS = [
  { type: 'intake', batch: 'RM-1' },
  { type: 'intake', batch: 'RM-2' },
  { type: 'inspect', id: 'IN-1', batch: 'RM-1', test: 'micro', status: 'fail' },
  { type: 'mix', output: 'B-1', inputs: ['RM-1', 'RM-2'] },
  { type: 'split', input: 'B-1', outputs: ['P-1'] },
  { type: 'scrap', batch: 'B-1', reason: 'qa-hold' },
];

test('tombstone blocks downstream splits but keeps upstream evidence', () => {
  const state = lineage.buildState(EVENTS);
  // The scrapped batch and its upstream stay contaminated (evidence kept).
  assert.ok(state.contaminated.has('RM-1'));
  assert.ok(state.contaminated.has('B-1'));
  // The tombstone blocks propagation past B-1, even for the earlier split.
  assert.ok(!state.contaminated.has('P-1'));

  // A split registered AFTER the scrap must not revive the risk either.
  lineage.appendEvents(state, [{ type: 'split', input: 'B-1', outputs: ['P-2'] }]);
  assert.ok(!state.contaminated.has('P-2'), 'tombstoned parent must not propagate');
  assert.ok(state.contaminated.has('B-1'), 'tombstone keeps the batch verdict');
  assert.ok(state.contaminated.has('RM-1'), 'upstream evidence preserved');

  const certificate = lineage.buildCertificate(state);
  assert.deepEqual(certificate.tombstones, ['B-1']);
  const b1 = certificate.boundary.find((b) => b.batch === 'B-1');
  assert.equal(b1.kind, 'tombstone');
  assert.ok(!certificate.affected_products.includes('P-1'));
  assert.ok(!certificate.affected_products.includes('P-2'));
});

test('scrap before any split keeps the whole downstream clean', () => {
  const state = lineage.buildState([
    { type: 'intake', batch: 'RM-1' },
    { type: 'inspect', id: 'IN-1', batch: 'RM-1', test: 'micro', status: 'fail' },
    { type: 'scrap', batch: 'RM-1' },
    { type: 'mix', output: 'B-1', inputs: ['RM-1'] },
    { type: 'split', input: 'B-1', outputs: ['P-1'] },
  ]);
  assert.ok(state.contaminated.has('RM-1'));
  assert.ok(!state.contaminated.has('B-1'));
  assert.ok(!state.contaminated.has('P-1'));
});

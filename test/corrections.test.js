'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { iso } = require('./helpers');

function branchLots() {
  return [
    { id: 'RM-A', type: 'raw_material', production_start: iso(10), production_end: iso(20) },
    { id: 'RM-B', type: 'raw_material', production_start: iso(10), production_end: iso(20) },
    { id: 'RM-C', type: 'raw_material', production_start: iso(10), production_end: iso(20) },
    { id: 'MIX', type: 'intermediate', production_start: iso(30), production_end: iso(40) },
    { id: 'FG-1', type: 'finished_good', production_start: iso(50), production_end: iso(60) },
    { id: 'FG-2', type: 'finished_good', production_start: iso(50), production_end: iso(60) },
  ];
}

function branchEdges() {
  return [
    { from: 'RM-A', to: 'MIX', valid_from: iso(0), valid_to: iso(100) },
    { from: 'RM-B', to: 'MIX', valid_from: iso(0), valid_to: iso(100) },
    { from: 'MIX', to: 'FG-1', valid_from: iso(0), valid_to: iso(100) },
    { from: 'RM-C', to: 'FG-2', valid_from: iso(0), valid_to: iso(100) },
  ];
}

function makeEngine(tests) {
  const engine = new Engine({ lots: branchLots(), edges: branchEdges(), tests });
  assert.deepEqual(engine.errors, []);
  engine.computeAll();
  engine.issueCertificates();
  return engine;
}

test('revoking a failing test flips only downstream finished goods FAIL -> UNKNOWN', () => {
  const engine = makeEngine([
    { id: 'T1', lot: 'RM-A', result: 'fail' },
    { id: 'T2', lot: 'RM-B', result: 'pass' },
    { id: 'T3', lot: 'RM-C', result: 'pass' },
  ]);
  assert.equal(engine.state.get('FG-1').status, 'FAIL');
  assert.equal(engine.state.get('FG-2').status, 'PASS');
  const fg2HashBefore = engine.certs.get('FG-2').hash;
  const fg1HashBefore = engine.certs.get('FG-1').hash;

  const err = engine.applyCorrection({ type: 'revoke_test', test_id: 'T1' });
  assert.equal(err, null);

  // Only the downstream cone of RM-A was recomputed (3 lots, not all 6).
  assert.equal(engine.stats.lotsRecomputed, 3);
  assert.equal(engine.state.get('FG-1').status, 'UNKNOWN');
  assert.notEqual(engine.state.get('FG-1').status, 'FAIL');
  // Unrelated branch is untouched: same status, same certificate.
  assert.equal(engine.state.get('FG-2').status, 'PASS');
  assert.equal(engine.certs.get('FG-2').hash, fg2HashBefore);
  assert.equal(engine.certs.get('FG-2').seq, 1);
  // FG-1 got a new certificate and the old one is revoked.
  const fg1 = engine.certs.get('FG-1');
  assert.notEqual(fg1.hash, fg1HashBefore);
  assert.equal(fg1.seq, 2);
  const old = engine.certLog.find((c) => c.lot === 'FG-1' && c.seq === 1);
  assert.equal(old.state, 'revoked');
  assert.equal(old.superseded_by, fg1.hash);
});

test('revoking a failing test can flip FAIL -> PASS when passing evidence exists', () => {
  const engine = makeEngine([
    { id: 'T1', lot: 'RM-A', result: 'fail' },
    { id: 'T1b', lot: 'RM-A', result: 'pass' },
    { id: 'T2', lot: 'RM-B', result: 'pass' },
  ]);
  assert.equal(engine.state.get('FG-1').status, 'FAIL');
  assert.equal(engine.applyCorrection({ type: 'revoke_test', test_id: 'T1' }), null);
  assert.equal(engine.state.get('RM-A').status, 'PASS');
  assert.equal(engine.state.get('MIX').status, 'PASS');
  assert.equal(engine.state.get('FG-1').status, 'PASS');
});

test('updating edge time to break the propagation window reissues certificates with a revocation chain', () => {
  const engine = makeEngine([
    { id: 'T1', lot: 'RM-A', result: 'fail' },
    { id: 'T2', lot: 'RM-B', result: 'pass' },
  ]);
  assert.equal(engine.state.get('FG-1').status, 'FAIL');
  const before = engine.certs.get('FG-1');

  // Shrink the RM-A -> MIX validity window so it no longer covers the
  // MIX production window [10h, 40h]... window becomes [60h, 70h].
  const err = engine.applyCorrection({
    type: 'update_edge',
    from: 'RM-A',
    to: 'MIX',
    valid_from: iso(60),
    valid_to: iso(70),
  });
  assert.equal(err, null);

  // RM-A still carries its own failing test, so PASS cannot propagate;
  // the lots drop from FAIL to UNKNOWN (missing evidence), never to FAIL.
  assert.equal(engine.state.get('MIX').status, 'UNKNOWN');
  assert.equal(engine.state.get('FG-1').status, 'UNKNOWN');
  const after = engine.certs.get('FG-1');
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.seq, 2);
  // Old certificate recorded as revoked, pointing at its replacement.
  const revoked = engine.certLog.find((c) => c.lot === 'FG-1' && c.seq === 1);
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.superseded_by, after.hash);
  // MIX certificate chain also moved; RM-A keeps its own FAIL status.
  assert.equal(engine.state.get('RM-A').status, 'FAIL');
});

test('corrections against unknown targets are rejected without touching state', () => {
  const engine = makeEngine([{ id: 'T1', lot: 'RM-A', result: 'fail' }]);
  const hashBefore = engine.certs.get('FG-1').hash;
  const err1 = engine.applyCorrection({ type: 'revoke_test', test_id: 'NOPE' });
  assert.equal(err1.error, 'unknown_test');
  const err2 = engine.applyCorrection({ type: 'update_edge', from: 'RM-A', to: 'FG-1' });
  assert.equal(err2.error, 'unknown_edge');
  const err3 = engine.applyCorrection({ type: 'revoke_test', test_id: 'T1' });
  assert.equal(err3, null);
  const err4 = engine.applyCorrection({ type: 'revoke_test', test_id: 'T1' });
  assert.equal(err4.error, 'test_already_revoked');
  assert.equal(engine.stats.correctionsApplied, 1);
  assert.notEqual(engine.certs.get('FG-1').hash, hashBefore);
});

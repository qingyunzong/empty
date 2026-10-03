'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeConfig, makeStore, submitEvent, engine } = require('./helpers');

test('acceptance 3: correcting one evidence re-verifies downstream and changes certificates', () => {
  const store = makeStore();
  const config = makeConfig();
  engine.execute(store, config, 'submit', [
    submitEvent('A', { lamport: 1 }),
    submitEvent('B', { lamport: 2, dependsOn: ['A'] }),
  ]);
  engine.execute(store, config, 'verify', [
    { lamport: 3, client: 'c', hash: 'vA', packId: 'A' },
    { lamport: 4, client: 'c', hash: 'vB', packId: 'B' },
  ]);
  const certBBefore = store.state.certs.B.certHash;
  const rootBefore = engine.computeDigest(store.state).stateRoot;

  const fix = engine.execute(store, config, 'correct', [
    { lamport: 5, client: 'c', hash: 'fixA', packId: 'A', chain: engine.buildChain('A-fixed', 3), payload: 'A-fixed' },
  ]);
  const fixResult = fix.results[0];
  assert.equal(fixResult.oldPackId, 'A');
  assert.equal(fixResult.newPackId, 'A#c1');
  assert.deepEqual(fixResult.invalidated, ['B'], 'dependent B invalidated');
  assert.equal(store.state.certs.B, undefined, 'stale certificate of B revoked');
  assert.equal(store.state.certs.A, undefined, 'superseded certificate of A revoked');
  assert.equal(store.state.packs.A.status, 'superseded');
  assert.ok(['queued', 'scheduled'].includes(store.state.packs.B.status), 'B back in the verification pipeline');

  engine.execute(store, config, 'verify', [
    { lamport: 6, client: 'c', hash: 'vA2', packId: 'A#c1' },
    { lamport: 7, client: 'c', hash: 'vB2', packId: 'B' },
  ]);
  const certBAfter = store.state.certs.B.certHash;
  assert.notEqual(certBAfter, certBBefore, 'certificate changes after re-verification');
  const rootAfter = engine.computeDigest(store.state).stateRoot;
  assert.notEqual(rootAfter, rootBefore, 'state root changes');
  assert.equal(fix.digest.rulesVersion, 'evidence-pack-rules/1.0.0');
  assert.ok(fix.digest.inputEventsHash);
});

test('recall rolls back the whole revocation tree and frees quota', () => {
  const store = makeStore();
  const config = makeConfig();
  engine.execute(store, config, 'submit', [
    submitEvent('A', { lamport: 1, size: 10 }),
    submitEvent('B', { lamport: 2, size: 10, dependsOn: ['A'] }),
    submitEvent('C', { lamport: 3, size: 10, dependsOn: ['B'] }),
  ]);
  engine.execute(store, config, 'verify', [
    { lamport: 4, client: 'c', hash: 'vA', packId: 'A' },
    { lamport: 5, client: 'c', hash: 'vB', packId: 'B' },
    { lamport: 6, client: 'c', hash: 'vC', packId: 'C' },
  ]);
  assert.equal(store.state.quotas.t1.used, 30);
  const r = engine.execute(store, config, 'recall', [{ lamport: 7, client: 'c', hash: 'rA', packId: 'A' }]);
  assert.deepEqual(r.results[0].rolledBack, ['A', 'B', 'C'], 'level-order tree rollback');
  for (const id of ['A', 'B', 'C']) {
    assert.equal(store.state.packs[id].status, 'recalled');
    assert.equal(store.state.certs[id], undefined);
  }
  assert.equal(store.state.quotas.t1.used, 0, 'quota released on recall');
  const digest = engine.computeDigest(store.state);
  const replay = engine.computeDigest(JSON.parse(JSON.stringify(store.state)));
  assert.equal(digest.stateRoot, replay.stateRoot, 'digest recomputable after rollback');
});

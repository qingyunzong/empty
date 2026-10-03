'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, cli, writeConfig, snapshotOf } = require('./helpers');
const { quotaProof } = require('../src/core');
const { Store } = require('../src/store');

const QUOTA = 1000;

function setup() {
  const dir = tmpDir();
  const cfgPath = writeConfig(dir, {
    workers: [{ id: 'w1', throughput: 10, maxLevel: 3 }],
    quotas: { T: QUOTA },
    periodLength: 100,
    boostThreshold: 1000,
  });
  assert.equal(cli(['init', '--dir', dir, '--config', cfgPath]).status, 0);
  return dir;
}

function submitChain(dir, ids) {
  let prev = 'GENESIS';
  const hashes = {};
  for (const id of ids) {
    const r = cli([
      'submit', '--dir', dir,
      '--id', id, '--tenant', 'T', '--submitter', 's1',
      '--size', '5', '--level', '1', '--deadline', '50',
      '--prev-hash', prev, '--evidence-hash', `ev-${id}-v1`,
      '--client', 'c1', '--lamport', '1',
      '--quota-proof', quotaProof('T', QUOTA),
    ]);
    assert.equal(r.status, 0, r.stderr);
    hashes[id] = r.json.submitted[0].hash;
    prev = hashes[id];
  }
  return hashes;
}

test('correction triggers downstream re-verify and certificates change', () => {
  const dir = setup();
  submitChain(dir, ['p1', 'p2', 'p3']);
  const v0 = cli(['verify', '--dir', dir, '--now', '0']);
  assert.equal(v0.status, 0, v0.stderr);
  const certsBefore = {};
  for (const r of v0.json.results) certsBefore[r.pkg] = r.cert;
  assert.equal(Object.keys(certsBefore).length, 3);

  // Evidence p1 fails verification, then is corrected.
  assert.equal(cli(['verify', '--dir', dir, '--fail', 'p1']).status, 0);
  assert.equal(snapshotOf(dir).state.packages.p1.status, 'failed');
  const c = cli(['correct', '--dir', dir, '--pkg', 'p1', '--size', '6', '--evidence-hash', 'ev-p1-v2']);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.json.version, 2);
  assert.deepEqual(c.json.stale, ['p2', 'p3'], 'downstream packages marked for re-verify');
  let snap = snapshotOf(dir).state;
  assert.equal(snap.packages.p2.status, 'stale');
  assert.equal(snap.packages.p3.status, 'stale');
  assert.equal(snap.packages.p2.cert, null, 'stale package certificate revoked');

  // Re-verify: the whole chain is verified again with new certificates.
  const v1 = cli(['verify', '--dir', dir, '--now', '1']);
  assert.equal(v1.status, 0, v1.stderr);
  snap = snapshotOf(dir).state;
  for (const id of ['p1', 'p2', 'p3']) {
    assert.equal(snap.packages[id].status, 'verified');
    assert.ok(snap.packages[id].cert, `${id} re-certified`);
    assert.notEqual(snap.packages[id].cert, certsBefore[id], `${id} certificate changed after correction`);
  }
});

test('recall rolls back the tree hierarchically; digest is recomputable after recovery', () => {
  const dir = setup();
  submitChain(dir, ['p1', 'p2', 'p3']);
  assert.equal(cli(['verify', '--dir', dir, '--now', '0']).status, 0);

  const r = cli(['recall', '--dir', dir, '--pkg', 'p2']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.rolledBack, [
    { id: 'p2', depth: 0 },
    { id: 'p3', depth: 1 },
  ], 'recall tree rolls back level by level');
  let snap = snapshotOf(dir).state;
  assert.equal(snap.packages.p1.status, 'verified', 'ancestor outside the recall tree is untouched');
  assert.equal(snap.packages.p2.status, 'recalled');
  assert.equal(snap.packages.p3.status, 'recalled');
  assert.equal(snap.packages.p3.recallDepth, 1);
  assert.equal(snap.packages.p3.cert, null, 'certificate revoked on rollback');

  // Recover: correct the recalled package and re-verify.
  assert.equal(cli(['correct', '--dir', dir, '--pkg', 'p2', '--size', '5', '--evidence-hash', 'ev-p2-v2']).status, 0);
  assert.equal(cli(['verify', '--dir', dir, '--now', '2']).status, 0);
  snap = snapshotOf(dir).state;
  for (const id of ['p1', 'p2', 'p3']) assert.equal(snap.packages[id].status, 'verified');

  // The digest is recomputable: replaying the journal yields the same state root.
  const store = new Store(dir);
  const { events } = store.readJournal();
  const replayed = store.replay(events);
  const { computeStateRoot } = require('../src/core');
  assert.equal(computeStateRoot(replayed), snapshotOf(dir).stateRoot);
  const a = cli(['audit', '--dir', dir]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.digest.stateRoot, snapshotOf(dir).stateRoot);
});

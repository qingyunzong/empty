'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, cli, writeConfig, snapshotOf } = require('./helpers');
const { quotaProof, applyEvent, computeStateRoot } = require('../src/core');
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
  const r = cli([
    'submit', '--dir', dir,
    '--id', 'p1', '--tenant', 'T', '--submitter', 's1',
    '--size', '5', '--level', '1', '--deadline', '50',
    '--prev-hash', 'GENESIS', '--evidence-hash', 'ev-p1',
    '--client', 'c1', '--lamport', '1', '--quota-proof', quotaProof('T', QUOTA),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cli(['verify', '--dir', dir, '--now', '0']).status, 0);
  return dir;
}

function submitEvent(id, prevHash) {
  return {
    type: 'submit',
    lamport: 2,
    payload: {
      id, tenant: 'T', submitter: 's1', size: 5, level: 1, deadline: 50,
      prevHash, evidenceHash: `ev-${id}`, client: 'c1', lamport: 2,
      quotaProof: quotaProof('T', QUOTA),
    },
  };
}

test('audit recovers when the crash happens before the state write', () => {
  const dir = setup();
  const store = new Store(dir);
  // Simulate crash: event is journaled but the state snapshot was not written.
  const head = store.replay(store.readJournal().events).submitterHeads.s1;
  store.appendEvent(submitEvent('p2', head));
  const before = snapshotOf(dir);
  assert.equal(before.state.packages.p2, undefined);

  const a = cli(['audit', '--dir', dir]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.report.snapshot, 'replayed-forward');
  const after = snapshotOf(dir);
  assert.ok(after.state.packages.p2, 'journal event replayed into state');
  assert.equal(after.seq, store.readJournal().events.length);
  // Digest is recomputable from the journal alone.
  const replayed = store.replay(store.readJournal().events);
  assert.equal(computeStateRoot(replayed), a.json.digest.stateRoot);
});

test('audit recovers when the crash happens after the state write', () => {
  const dir = setup();
  const store = new Store(dir);
  // Simulate crash: state snapshot advanced but the journal event was lost.
  const { state } = store.load();
  const head = state.submitterHeads.s1;
  applyEvent(state, submitEvent('p2', head));
  store.writeSnapshot(state);
  assert.ok(snapshotOf(dir).state.packages.p2);

  const a = cli(['audit', '--dir', dir]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.report.snapshot, 'rolled-back');
  const after = snapshotOf(dir);
  assert.equal(after.state.packages.p2, undefined, 'phantom state rolled back to journal');
  assert.equal(after.seq, store.readJournal().events.length);
  const replayed = store.replay(store.readJournal().events);
  assert.equal(computeStateRoot(replayed), a.json.digest.stateRoot);
});

test('audit truncates a corrupt journal tail and stays consistent', () => {
  const dir = setup();
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"seq":99,"bogus":true}\n');
  const a = cli(['audit', '--dir', dir]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.report.journalCorrupt, true);
  // Normal commands work again afterwards.
  const head = snapshotOf(dir).state.submitterHeads.s1;
  const r = cli([
    'submit', '--dir', dir,
    '--id', 'p2', '--tenant', 'T', '--submitter', 's1',
    '--size', '5', '--level', '1', '--deadline', '50',
    '--prev-hash', head, '--evidence-hash', 'ev-p2',
    '--client', 'c1', '--lamport', '2', '--quota-proof', quotaProof('T', QUOTA),
  ]);
  assert.equal(r.status, 0, r.stderr);
  const a2 = cli(['audit', '--dir', dir]);
  assert.equal(a2.json.report.snapshot, 'ok');
  assert.equal(a2.json.report.journalCorrupt, false);
});

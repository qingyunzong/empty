'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, makeConfig, submitEvent, engine, Store } = require('./helpers');

test('acceptance 4a: crash before state write is rolled back by audit', () => {
  const dir = tmpDir();
  const config = makeConfig();
  const store = new Store(dir);
  engine.execute(store, config, 'submit', [submitEvent('p1', { lamport: 1 })]);
  const rootBefore = store.stateRoot();
  const seqBefore = store.state.seq;

  fs.appendFileSync(
    path.join(dir, 'journal.log'),
    JSON.stringify({ seq: seqBefore + 1, command: 'submit', payload: { events: [] }, phase: 'begin', ts: 'x' }) + '\n'
  );

  const store2 = new Store(dir);
  const report = engine.audit(store2, config);
  assert.equal(report.recovery.recovered, true);
  assert.equal(report.recovery.rolledBackSeq, seqBefore + 1);
  assert.equal(store2.state.seq, seqBefore, 'state untouched by the incomplete command');
  assert.equal(store2.stateRoot(), rootBefore, 'state root identical after recovery');
  assert.ok(report.digest.stateRoot);
});

test('acceptance 4b: crash after state write but before journal commit recovers consistently', () => {
  const dir = tmpDir();
  const config = makeConfig();
  const store = new Store(dir);
  engine.execute(store, config, 'submit', [submitEvent('p1', { lamport: 1 })]);

  const record = store.begin('submit', { events: [submitEvent('p2', { lamport: 2 })] });
  const nextState = JSON.parse(JSON.stringify(store.state));
  nextState.seq = record.seq;
  nextState.packs.p2 = { packId: 'p2', status: 'queued' };
  nextState.wal.push({ seq: record.seq, command: 'submit', payload: {}, hash: 'manual' });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(nextState));

  const store2 = new Store(dir);
  assert.equal(store2.state.seq, record.seq, 'state file already advanced');
  const report = engine.audit(store2, config);
  assert.equal(report.recovery.recovered, true, 'dangling begin detected');
  assert.equal(store2.state.packs.p2.packId, 'p2', 'durable state preserved');

  const r = engine.execute(store2, config, 'verify', [{ lamport: 3, client: 'c', hash: 'v', packId: 'p1' }]);
  assert.equal(r.ok, true, 'system keeps accepting commands after recovery');
  const report2 = engine.audit(new Store(dir), config);
  assert.equal(report2.recovery.recovered, false, 'journal clean after recovery');
  assert.equal(report2.digest.stateRoot, engine.computeDigest(store2.state).stateRoot);
});

test('audit on a clean journal reports no recovery and a verifiable digest', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const config = makeConfig();
  const r = engine.execute(store, config, 'submit', [submitEvent('p1', { lamport: 1 })]);
  const report = engine.audit(new Store(dir), config);
  assert.equal(report.recovery.recovered, false);
  assert.equal(report.digest.stateRoot, r.digest.stateRoot, 'digest stable across reload');
  assert.equal(report.digest.inputEventsHash, r.digest.inputEventsHash);
  assert.equal(report.digest.rulesVersion, r.digest.rulesVersion);
});

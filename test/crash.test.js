'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/engine');
const persist = require('../src/persist');
const { ts } = require('../test-support/helpers');

const EVENTS = [
  { type: 'internal', id: 'I1', amount: 60, ts: ts(10) },
  { type: 'internal', id: 'I2', amount: 40, ts: ts(11) },
  { type: 'external', id: 'E1', amount: 100, ts: ts(12) },
  { type: 'rule', version: 'v2' },
  { type: 'internal', id: 'I3', amount: 25, ts: ts(40) },
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recon-test-'));
}

function journaledEngine(dir) {
  const engine = new Engine();
  fs.mkdirSync(dir, { recursive: true });
  for (const event of EVENTS) {
    engine.apply(event);
    persist.appendJournal(dir, engine.seq, event);
  }
  return engine;
}

test('crash mid-write of cluster index: restart rebuilds without duplicate clusters', () => {
  const dir = tmpDir();
  const engine = journaledEngine(dir);
  const expected = engine.getAllClusters();

  assert.throws(
    () => persist.commit(dir, engine, { faultAt: 'clusters' }),
    persist.SimulatedCrashError
  );
  const p = persist.paths(dir);
  // torn write: partial tmp left behind, committed index never appeared
  assert.ok(fs.existsSync(p.clusters + '.tmp'));
  assert.ok(!fs.existsSync(p.clusters));

  const recovered = persist.recover(dir);
  assert.equal(recovered.indexRebuilt, true);
  const clusters = recovered.engine.getAllClusters();
  assert.deepEqual(clusters, expected);
  const ids = clusters.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate cluster ids after restart');

  // rebuilt index on disk contains each cluster exactly once
  const onDisk = JSON.parse(fs.readFileSync(p.clusters, 'utf8'));
  assert.deepEqual(
    onDisk.clusters.map((c) => c.id).sort(),
    ids.slice().sort()
  );

  // second restart with a healthy index: no rebuild, identical state
  const again = persist.recover(dir);
  assert.equal(again.indexRebuilt, false);
  assert.deepEqual(again.engine.getAllClusters(), expected);
});

test('crash on second commit (stale index + manifest mismatch) recovers via journal', () => {
  const dir = tmpDir();
  const engine = journaledEngine(dir);
  persist.commit(dir, engine); // healthy first commit

  engine.apply({ type: 'revoke', id: 'E1' });
  persist.appendJournal(dir, engine.seq, { type: 'revoke', id: 'E1' });
  engine.apply({ type: 'external', id: 'E2', amount: 100, ts: ts(13) });
  persist.appendJournal(dir, engine.seq, { type: 'external', id: 'E2', amount: 100, ts: ts(13) });

  assert.throws(
    () => persist.commit(dir, engine, { faultAt: 'clusters' }),
    persist.SimulatedCrashError
  );

  const recovered = persist.recover(dir);
  assert.equal(recovered.indexRebuilt, true);
  assert.deepEqual(recovered.engine.getAllClusters(), engine.getAllClusters());
  assert.equal(recovered.engine.history.length, 1);
  assert.equal(recovered.engine.history[0].type, 'REVOKED_MATCH');
  const ids = recovered.engine.getAllClusters().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

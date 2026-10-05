'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const wip = require('../src/index.js');
const { tmpDir, cleanup } = require('./helpers.js');

const CRASH = new Error('simulated crash');

// Fault point 1: crash before the scan hits scan.log -> nothing persisted, rescan.
test('crash before scan persisted: resume shows nothing, operator rescans', () => {
  const dir = tmpDir();
  try {
    const store = new wip.Store(dir);
    wip.begin(store, { session: 'S1', node: 'A' });
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 2 });

    const crashing = new wip.Store(dir, { beforeScanAppend() { throw CRASH; } });
    assert.throws(() => wip.scan(crashing, { session: 'S1', bin: 'A-01', item: 'ITM-0002', qty: 7 }), /simulated crash/);

    const summary = wip.resume(new wip.Store(dir));
    assert.equal(summary.replayed, 0);
    const sess = new wip.Store(dir).loadSession('S1');
    assert.equal(sess.ops.length, 1); // only the first scan survived
    assert.equal(fs.readFileSync(dir + '/scan.log', 'utf8').trim().split('\n').length, 1);

    // rescan of the lost event works and lands exactly once
    const store2 = new wip.Store(dir);
    wip.scan(store2, { session: 'S1', bin: 'A-01', item: 'ITM-0002', qty: 7 });
    wip.close(store2, { session: 'S1' });
    assert.equal(store2.loadState().inventory['A-01|ITM-0002'], 7);
    assert.equal(wip.verify(store2).ok, true);
  } finally { cleanup(dir); }
});

// Fault point 2: crash after scan.log append, before session tmp rename ->
// tmp discarded, event replayed from cursor into the session.
test('crash before session tmp rename: tmp discarded, replay from cursor restores the scan', () => {
  const dir = tmpDir();
  try {
    const store = new wip.Store(dir);
    wip.begin(store, { session: 'S1', node: 'A' });
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 1 });

    const crashing = new wip.Store(dir, { beforeSessionRename() { throw CRASH; } });
    assert.throws(() => wip.scan(crashing, { session: 'S1', bin: 'A-01', item: 'ITM-0002', qty: 4 }), /simulated crash/);

    // tmp file exists pre-resume, cursor still points before the second event
    assert.ok(fs.existsSync(dir + '/sessions/S1.json.tmp'));
    const before = new wip.Store(dir);
    assert.equal(before.loadSession('S1').ops.length, 1);
    assert.ok(before.loadCursor().offset < fs.statSync(dir + '/scan.log').size);

    const summary = wip.resume(new wip.Store(dir));
    assert.equal(fs.existsSync(dir + '/sessions/S1.json.tmp'), false); // tmp discarded
    assert.equal(summary.replayed, 1);
    const sess = new wip.Store(dir).loadSession('S1');
    assert.equal(sess.ops.length, 2);
    assert.equal(sess.ops[1].item, 'ITM-0002');
    assert.equal(sess.ops[1].delta, 4);

    // resume is idempotent: second run replays nothing
    const again = wip.resume(new wip.Store(dir));
    assert.equal(again.replayed, 0);
    assert.equal(new wip.Store(dir).loadSession('S1').ops.length, 2);
  } finally { cleanup(dir); }
});

// Fault point 3: crash after ledger commit, before session file removal ->
// ledger kept, leftover session finalized on resume.
test('crash after ledger commit: ledger kept, stale session cleaned up', () => {
  const dir = tmpDir();
  try {
    const store = new wip.Store(dir);
    wip.begin(store, { session: 'S1', node: 'A' });
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 6 });

    const crashing = new wip.Store(dir, { afterLedgerCommit() { throw CRASH; } });
    assert.throws(() => wip.close(crashing, { session: 'S1' }), /simulated crash/);

    // ledger committed, session file still on disk
    const mid = new wip.Store(dir);
    assert.equal(mid.loadState().inventory['A-01|ITM-0001'], 6);
    assert.ok(mid.loadSession('S1'));

    const summary = wip.resume(new wip.Store(dir));
    assert.equal(summary.finalized, 1);
    const after = new wip.Store(dir);
    assert.equal(after.loadState().inventory['A-01|ITM-0001'], 6); // ledger kept
    assert.equal(after.loadSession('S1'), null);
    assert.equal(after.loadState().ops.length, 1); // no double-commit
    assert.equal(wip.verify(after).ok, true);
  } finally { cleanup(dir); }
});

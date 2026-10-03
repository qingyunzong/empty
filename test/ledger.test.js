'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../src/ledger');
const { run } = require('../src/cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
}

// Drives the CLI in-process. Each invocation opens a fresh Ledger, i.e. does
// full recovery from disk exactly like a separate OS process would (spawning
// real subprocesses is not possible in every environment).
function runCli(dir, args, { expectFail = false } = {}) {
  let stdout = '';
  const status = run(['--data', dir, ...args], (line) => {
    stdout += line + '\n';
  });
  if (!expectFail && status !== 0) {
    throw new Error(`cli failed: ${args.join(' ')}`);
  }
  return { status, stdout };
}

function dump(dir) {
  return JSON.parse(runCli(dir, ['dump']).stdout);
}

// Independent enumeration of the WAL: replay every record from scratch and
// derive committed balances, the secondary index and full version chains
// without using the library under test.
function replayWal(dir) {
  const committed = {};
  const index = {};
  const versions = {};
  let watermark = 0;
  const walPath = path.join(dir, 'wal.log');
  if (!fs.existsSync(walPath)) return { watermark, committed, index, versions };
  for (const line of fs.readFileSync(walPath, 'utf8').split('\n')) {
    if (!line) continue;
    const rec = JSON.parse(line);
    watermark = rec.lsn;
    if (rec.op === 'pay') {
      const balance = (committed[rec.account] ?? 0) + rec.amount;
      committed[rec.account] = balance;
      (versions[rec.account] ??= []).push({ version: rec.lsn, balance, tx: rec.tx, op: 'pay' });
      index[rec.tx] = { tx: rec.tx, account: rec.account, amount: rec.amount, status: 'paid', version: rec.lsn };
    } else if (rec.op === 'cancel') {
      const balance = (committed[rec.account] ?? 0) - rec.amount;
      committed[rec.account] = balance;
      (versions[rec.account] ??= []).push({ version: rec.lsn, balance, tx: rec.tx, op: 'reversal' });
      index[rec.tx].status = 'cancelled';
      index[rec.tx].cancelVersion = rec.lsn;
    }
  }
  return { watermark, committed, index, versions };
}

// Expected version chains after GC with oldest-active-snapshot watermark
// `floor` (Infinity when no snapshot is active).
function gcChains(versions, floor) {
  const out = {};
  for (const [account, chain] of Object.entries(versions)) {
    if (floor === Infinity) {
      out[account] = [chain[chain.length - 1]];
    } else {
      const kept = chain.filter((v) => v.version > floor);
      const base = [...chain].reverse().find((v) => v.version <= floor);
      out[account] = base ? [base, ...kept] : kept;
    }
  }
  return out;
}

test('acceptance 1: checkpoint keeps versions pinned by an active snapshot', () => {
  const dir = tmpDir();
  runCli(dir, ['pay', '--tx', 't1', '--account', 'alice', '--amount', '100']);
  runCli(dir, ['pay', '--tx', 't2', '--account', 'alice', '--amount', '50']);
  const snap = runCli(dir, ['begin-snapshot']).stdout.trim(); // watermark = 2
  runCli(dir, ['pay', '--tx', 't3', '--account', 'alice', '--amount', '25']);
  runCli(dir, ['checkpoint']);

  // Old account state is still readable through the snapshot after checkpoint.
  assert.equal(runCli(dir, ['get', '--account', 'alice', '--at', snap]).stdout.trim(), '150');
  assert.equal(runCli(dir, ['get', '--account', 'alice', '--at', '2']).stdout.trim(), '150');
  assert.equal(runCli(dir, ['get', '--account', 'alice']).stdout.trim(), '175');

  // GC kept the version the snapshot reads (v2) plus newer ones, dropped v1.
  assert.deepEqual(dump(dir).versions.alice, [
    { version: 2, balance: 150, tx: 't2', op: 'pay' },
    { version: 3, balance: 175, tx: 't3', op: 'pay' },
  ]);

  // After the snapshot ends, a new checkpoint collects the pinned version.
  runCli(dir, ['end-snapshot', '--id', snap]);
  runCli(dir, ['checkpoint']);
  assert.deepEqual(dump(dir).versions.alice, [{ version: 3, balance: 175, tx: 't3', op: 'pay' }]);
});

test('acceptance 1 (in-process): snapshot reads survive checkpoint and restart', () => {
  const dir = tmpDir();
  const ledger = new Ledger(dir);
  ledger.pay('t1', 'alice', 100);
  ledger.pay('t2', 'alice', 50);
  const snap = ledger.beginSnapshot();
  ledger.pay('t3', 'bob', 7);
  ledger.checkpoint();
  assert.equal(ledger.getAt('alice', ledger.resolveAt(snap)), 150);

  const reopened = new Ledger(dir);
  assert.equal(reopened.getAt('alice', reopened.resolveAt(snap)), 150);
  assert.equal(reopened.getAt('alice', 1), 0); // v1 was collected, snapshot at 2 unaffected
});

test('acceptance 2 / C1: crash before tmp file is fully written, recover from WAL', () => {
  const dir = tmpDir();
  runCli(dir, ['pay', '--tx', 't1', '--account', 'alice', '--amount', '100']);
  runCli(dir, ['pay', '--tx', 't2', '--account', 'bob', '--amount', '40']);
  runCli(dir, ['pay', '--tx', 't3', '--account', 'alice', '--amount', '25']);
  runCli(dir, ['cancel', '--tx', 't2']);

  const crash = runCli(dir, ['crash', '--point', 'C1'], { expectFail: true });
  assert.notEqual(crash.status, 0);

  // Half-written tmp file exists; no checkpoint was installed.
  const tmp = fs.readFileSync(path.join(dir, 'checkpoint.json.tmp'), 'utf8');
  assert.throws(() => JSON.parse(tmp));
  assert.ok(!fs.existsSync(path.join(dir, 'checkpoint.json')));

  // Recovery ignores the half file and replays the WAL from scratch.
  const state = dump(dir);
  const expected = replayWal(dir);
  assert.equal(state.watermark, expected.watermark);
  assert.deepEqual(state.committed, expected.committed);
  assert.deepEqual(state.index, expected.index);
  assert.deepEqual(state.versions, expected.versions);

  // The stale tmp file is cleaned up; a fresh checkpoint now succeeds.
  assert.ok(!fs.existsSync(path.join(dir, 'checkpoint.json.tmp')));
  runCli(dir, ['checkpoint']);
  const after = dump(dir);
  assert.deepEqual(after.committed, expected.committed);
  assert.deepEqual(after.index, expected.index);
  assert.deepEqual(after.versions, gcChains(expected.versions, Infinity));
});

test('acceptance 2 / C2: crash before atomic rename, recover via old checkpoint + WAL', () => {
  const dir = tmpDir();
  runCli(dir, ['pay', '--tx', 't1', '--account', 'alice', '--amount', '100']);
  runCli(dir, ['pay', '--tx', 't2', '--account', 'bob', '--amount', '40']);
  runCli(dir, ['checkpoint']); // old checkpoint at version 2
  runCli(dir, ['pay', '--tx', 't3', '--account', 'alice', '--amount', '25']);
  runCli(dir, ['cancel', '--tx', 't1']);

  const crash = runCli(dir, ['crash', '--point', 'C2'], { expectFail: true });
  assert.notEqual(crash.status, 0);

  // Complete but unrenamed tmp file; the old checkpoint is still in place.
  const tmp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json.tmp'), 'utf8'));
  assert.equal(tmp.watermark, 4);
  const oldCheckpoint = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  assert.equal(oldCheckpoint.walLsn, 2);

  // Recovery uses the old checkpoint and replays the WAL tail; the unrenamed
  // tmp file is never adopted.
  const state = dump(dir);
  const expected = replayWal(dir);
  assert.equal(state.watermark, expected.watermark);
  assert.deepEqual(state.committed, expected.committed);
  assert.deepEqual(state.index, expected.index);
  assert.deepEqual(state.versions, gcChains(expected.versions, oldCheckpoint.walLsn));
  assert.ok(!fs.existsSync(path.join(dir, 'checkpoint.json.tmp')));
});

test('acceptance 3: pay then cancel after checkpoint, reversal correct after restart', () => {
  const dir = tmpDir();
  runCli(dir, ['pay', '--tx', 't1', '--account', 'alice', '--amount', '100']);
  runCli(dir, ['checkpoint']);
  runCli(dir, ['pay', '--tx', 't2', '--account', 'alice', '--amount', '50']);
  runCli(dir, ['cancel', '--tx', 't2']);

  // Fresh process => full recovery from checkpoint + WAL.
  const state = dump(dir);
  assert.deepEqual(state.committed, { alice: 100 });
  assert.equal(state.index.t2.status, 'cancelled');
  assert.equal(state.index.t2.cancelVersion, 3);
  assert.deepEqual(state.versions.alice, [
    { version: 1, balance: 100, tx: 't1', op: 'pay' },
    { version: 2, balance: 150, tx: 't2', op: 'pay' },
    { version: 3, balance: 100, tx: 't2', op: 'reversal' },
  ]);
  assert.equal(runCli(dir, ['get', '--account', 'alice']).stdout.trim(), '100');
  assert.equal(runCli(dir, ['get', '--account', 'alice', '--at', '2']).stdout.trim(), '150');
  assert.equal(runCli(dir, ['get', '--account', 'alice', '--at', '1']).stdout.trim(), '100');
});

test('invalid operations are rejected', () => {
  const dir = tmpDir();
  const ledger = new Ledger(dir);
  ledger.pay('t1', 'alice', 100);
  assert.throws(() => ledger.pay('t1', 'alice', 5), /duplicate tx/);
  assert.throws(() => ledger.pay('t2', 'alice', -3), /positive/);
  assert.throws(() => ledger.cancel('nope'), /unknown tx/);
  ledger.cancel('t1');
  assert.throws(() => ledger.cancel('t1'), /not paid/);
  assert.equal(ledger.getAt('alice', ledger.version), 0);
});

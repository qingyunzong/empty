'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../src/cli');

// The sandbox forbids spawning processes, so the CLI is exercised through
// its exported runCli() entry point (the same one the executable uses).
test('CLI: init, freeze, query, crash --prepared, cancel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cli-'));
  const wal = path.join(dir, 'quota.wal');

  let [res] = await runCli(['init', '--wal', wal, '--account', 'A', '--balance', '500', '--priority', '1']);
  assert.equal(res.ok, true);
  [res] = await runCli(['init', '--wal', wal, '--account', 'B', '--balance', '300', '--priority', '2']);
  assert.equal(res.ok, true);

  // Committed freeze across two accounts.
  [res] = await runCli(['freeze', '--wal', wal, 'A:100', 'B:50']);
  assert.equal(res.ok, true);
  assert.equal(res.items.length, 2);

  [res] = await runCli(['query', '--wal', wal, '--account', 'A']);
  assert.equal(res.available, 400);
  assert.equal(res.frozen, 100);

  // Freeze journaled with PREPARE only, then a crash: must not take effect.
  [res] = await runCli(['freeze', '--wal', wal, 'A:200', '--prepared']);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'prepared');
  [res] = await runCli(['crash', '--wal', wal, '--prepared']);
  assert.equal(res.crashed, true);
  assert.equal(res.prepared, true);

  [res] = await runCli(['query', '--wal', wal, '--account', 'A']);
  assert.equal(res.available, 400, 'prepared-but-uncommitted freeze must not apply');

  // Re-freezing the same account succeeds after recovery.
  [res] = await runCli(['freeze', '--wal', wal, 'A:200']);
  assert.equal(res.ok, true);
  [res] = await runCli(['query', '--wal', wal, '--account', 'A']);
  assert.equal(res.available, 200);

  // Cancel on a recovered (non-live) transaction is a harmless no-op.
  [res] = await runCli(['cancel', '--wal', wal, '--txn', 'T2']);
  assert.equal(res.ok, true);

  // Full query lists accounts and the priority-ordered scan. Only the two
  // committed freeze groups appear; the prepared-then-crashed one does not.
  [res] = await runCli(['query', '--wal', wal]);
  assert.equal(res.accounts.length, 2);
  assert.equal(res.scan.length, 2);
  assert.deepEqual(
    res.scan.map((group) => group.items.map((item) => item.account)),
    [['A'], ['A', 'B']]
  );
});

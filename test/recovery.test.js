'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QuotaEngine } = require('../src');

function tmpWal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-wal-'));
  return path.join(dir, 'quota.wal');
}

// Acceptance 3: after a crash with a PREPAREd (uncommitted) freeze, recovery
// leaves account availability unchanged and the account can be frozen again.
test('crash after PREPARE: uncommitted freeze never takes effect, re-freeze works', async () => {
  const wal = tmpWal();

  const first = QuotaEngine.open({ walPath: wal, lockTimeoutMs: 200 });
  first.addAccount('A', 500, 1);
  const committed = first.begin();
  await first.freeze(committed, 'A', 100);
  await first.commit(committed);
  assert.equal(first.availableOf('A'), 400);

  const doomed = first.begin();
  await first.freeze(doomed, 'A', 200);
  first.prepare(doomed); // PREPARE journaled, COMMIT never written
  first.crash(); // locks wiped, in-flight txn lost

  const recovered = QuotaEngine.open({ walPath: wal, lockTimeoutMs: 200 });
  // Available quota is exactly as after the last COMMIT.
  assert.equal(recovered.availableOf('A'), 400);
  assert.equal(recovered.query('A').frozen, 100);
  // Lock table is empty after recovery.
  assert.equal(recovered.locks.owners.size, 0);
  assert.equal(recovered.locks.waiters.size, 0);
  // The account can be frozen again right away.
  const retry = recovered.begin();
  await recovered.freeze(retry, 'A', 200);
  await recovered.commit(retry);
  assert.equal(recovered.availableOf('A'), 200);
  recovered.close();

  // And a fresh reopen still sees only committed freezes.
  const again = QuotaEngine.open({ walPath: wal, lockTimeoutMs: 200 });
  assert.equal(again.availableOf('A'), 200);
  again.close();
});

test('committed freezes survive a crash; lock table starts empty', async () => {
  const wal = tmpWal();
  const engine = QuotaEngine.open({ walPath: wal, lockTimeoutMs: 200 });
  engine.addAccount('A', 1000, 1);
  engine.addAccount('B', 300, 2);
  const txn = engine.begin();
  await engine.freeze(txn, 'A', 250);
  await engine.freeze(txn, 'B', 50);
  await engine.commit(txn);
  engine.crash();

  const recovered = QuotaEngine.open({ walPath: wal, lockTimeoutMs: 200 });
  assert.equal(recovered.availableOf('A'), 750);
  assert.equal(recovered.availableOf('B'), 250);
  assert.equal(recovered.locks.owners.size, 0);
  recovered.close();
});

test('abort records are not replayed as freezes', async () => {
  const wal = tmpWal();
  const engine = QuotaEngine.open({ walPath: wal, lockTimeoutMs: 200 });
  engine.addAccount('A', 100, 1);
  const txn = engine.begin();
  await engine.freeze(txn, 'A', 10);
  engine.abort(txn);
  engine.crash();

  const recovered = QuotaEngine.open({ walPath: wal, lockTimeoutMs: 200 });
  assert.equal(recovered.availableOf('A'), 100);
  recovered.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/database.js';
import { createGate, sleep } from '../test-utils.js';

// Acceptance 2: a transaction holding a lock sleeps; a third party waiting on
// the same account fails with E_LOCK_TIMEOUT after the configured timeout.

test('waiting transaction gets E_LOCK_TIMEOUT while holder sleeps', async () => {
  const db = new Database({ lockTimeoutMs: 80 });
  db.setAccount('A', 1000);
  const gate = createGate();

  const holder = db.transaction(async (tx) => {
    await tx.freeze('A', 100);
    gate.signal('locked');
    await sleep(300); // hold the lock well past the 80ms timeout
  });

  await gate.wait('locked');
  const started = Date.now();
  const waiter = db.transaction(async (tx) => {
    await tx.freeze('A', 50);
  });
  await assert.rejects(waiter, (err) => err.code === 'E_LOCK_TIMEOUT');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 70, `waited at least ~timeout (${elapsed}ms)`);
  assert.ok(elapsed < 250, `did not wait for holder commit (${elapsed}ms)`);

  await holder; // holder itself commits fine
  assert.equal(db.getAccount('A').frozen, 100);
  assert.equal(db.getAccount('A').available, 900);
});

test('default lock timeout is 200ms and is configurable', async () => {
  const dbDefault = new Database();
  assert.equal(dbDefault.lockManager.timeoutMs, 200);
  const dbCustom = new Database({ lockTimeoutMs: 50 });
  assert.equal(dbCustom.lockManager.timeoutMs, 50);
});

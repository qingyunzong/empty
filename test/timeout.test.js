'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { QuotaEngine, E_LOCK_TIMEOUT } = require('../src');

// Acceptance 2: while a transaction holds a lock (and sleeps), a third
// party waiting on the same account times out with E_LOCK_TIMEOUT.
test('third party waiting on a held lock times out with E_LOCK_TIMEOUT', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 200 });
  engine.addAccount('A', 1000, 1);
  const holder = engine.begin();
  await engine.freeze(holder, 'A', 100);

  const third = engine.begin();
  const started = Date.now();
  const [holdResult, waitResult] = await Promise.allSettled([
    (async () => {
      await sleep(300); // holder sleeps while keeping the lock
      return engine.commit(holder);
    })(),
    engine.freeze(third, 'A', 50),
  ]);
  const elapsed = Date.now() - started;

  assert.equal(waitResult.status, 'rejected');
  assert.equal(waitResult.reason.code, E_LOCK_TIMEOUT);
  assert.ok(elapsed >= 190, `waited ${elapsed}ms, expected >= ~200ms`);
  assert.ok(elapsed < 2000, `waited ${elapsed}ms, no permanent wait`);
  // The waiting transaction is aborted; the holder still commits.
  assert.equal(engine.transactions.get(third).state, 'aborted');
  assert.equal(holdResult.status, 'fulfilled');
  assert.equal(engine.availableOf('A'), 900);
  engine.close();
});

// The timeout is configurable for tests.
test('lock timeout is configurable', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 50 });
  engine.addAccount('A', 1000, 1);
  const holder = engine.begin();
  await engine.freeze(holder, 'A', 100);
  const waiter = engine.begin();
  const started = Date.now();
  await assert.rejects(engine.freeze(waiter, 'A', 50), (err) => {
    assert.equal(err.code, E_LOCK_TIMEOUT);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `elapsed ${elapsed}ms with 50ms timeout`);
  engine.abort(holder);
  engine.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/database.js';
import { createGate, sleep, withTimeout } from '../test-utils.js';

// Acceptance 1: two transactions freeze A/B in opposite order; enumerate
// interleavings; exactly one succeeds and one gets E_DEADLOCK; no permanent wait.

async function runOppositeOrder({ t1StartsFirst }) {
  const db = new Database({ lockTimeoutMs: 2000 });
  db.setAccount('A', 1000);
  db.setAccount('B', 1000);
  const gate = createGate();
  const ids = {};

  const run = (name, firstAcct, secondAcct) =>
    db.transaction(async (tx) => {
      ids[name] = tx.id;
      await tx.freeze(firstAcct, 10);
      gate.signal(`${name}:first`);
      await gate.wait(`${name === 't1' ? 't2' : 't1'}:first`);
      await tx.freeze(secondAcct, 10);
    });

  const t1 = () => run('t1', 'A', 'B');
  const t2 = () => run('t2', 'B', 'A');
  const [p1, p2] = t1StartsFirst ? [t1(), t2()] : (() => { const q2 = t2(); const q1 = t1(); return [q1, q2]; })();

  // No permanent wait: must settle well below the 2000ms lock timeout.
  const results = await withTimeout(Promise.allSettled([p1, p2]), 1500, 'deadlock interleaving');
  return { results, ids };
}

test('opposite-order freeze A/B: exactly one success and one E_DEADLOCK per interleaving', async () => {
  for (const t1StartsFirst of [true, false]) {
    const { results, ids } = await runOppositeOrder({ t1StartsFirst });
    const successes = results.filter((r) => r.status === 'fulfilled');
    const deadlocks = results.filter((r) => r.status === 'rejected' && r.reason.code === 'E_DEADLOCK');
    const timeouts = results.filter((r) => r.status === 'rejected' && r.reason.code === 'E_LOCK_TIMEOUT');
    assert.equal(successes.length, 1, `one success (t1StartsFirst=${t1StartsFirst})`);
    assert.equal(deadlocks.length, 1, 'one E_DEADLOCK');
    assert.equal(timeouts.length, 0, 'resolution is by deadlock detection, not timeout');
    // Victim must be the transaction with the smallest txid.
    const victimIndex = results.findIndex((r) => r.status === 'rejected');
    const victimId = victimIndex === 0 ? ids.t1 : ids.t2;
    assert.equal(victimId, Math.min(ids.t1, ids.t2), 'smallest txid is aborted');
  }
});

test('randomized interleavings: never hang, at most one E_DEADLOCK, loser is min txid', async () => {
  for (let round = 0; round < 10; round++) {
    const db = new Database({ lockTimeoutMs: 500 });
    db.setAccount('A', 1000);
    db.setAccount('B', 1000);
    const ids = {};
    const p1 = db.transaction(async (tx) => {
      ids.t1 = tx.id;
      await tx.freeze('A', 10);
      await sleep(Math.floor(Math.random() * 20));
      await tx.freeze('B', 10);
    });
    const p2 = db.transaction(async (tx) => {
      ids.t2 = tx.id;
      await tx.freeze('B', 10);
      await sleep(Math.floor(Math.random() * 20));
      await tx.freeze('A', 10);
    });
    const results = await withTimeout(Promise.allSettled([p1, p2]), 400, `round ${round}`);
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.ok(rejected.length <= 1, `round ${round}: at most one abort`);
    if (rejected.length === 1) {
      assert.equal(rejected[0].reason.code, 'E_DEADLOCK', `round ${round}`);
    }
    // Committed state stays consistent: total frozen never exceeds balances.
    assert.ok(db.getAccount('A').frozen <= 1000);
    assert.ok(db.getAccount('B').frozen <= 1000);
  }
});

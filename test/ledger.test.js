'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store');
const { cancelSlip } = require('../src/ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-ledger-'));
}

// Settles slip s1 for merchant m1 amount 100: creates the OPEN slip and
// posts the settlement entries (credit merchant, debit clearing).
async function setupOpenSlip(store) {
  const tx = await store.begin();
  tx.put('settle:s1', { id: 's1', merchant: 'm1', amount: 100, status: 'OPEN' });
  tx.put('account:m1', { balance: 100 });
  tx.put('account:clearing', { balance: -100 });
  const { version } = await tx.commit();
  return version;
}

test('acceptance 1: serial settle then cancel - balances, status, reversal entries', async () => {
  const store = new Store(tmpDir());
  const v1 = await setupOpenSlip(store);
  const tx = await store.begin();
  await cancelSlip(tx, 's1');
  const { version: v2 } = await tx.commit();
  assert.equal(v2, v1 + 1);

  const head = await store.currentVersion();
  assert.equal((await store.getAt('account:m1', head)).balance, 0, 'merchant balance reversed');
  assert.equal((await store.getAt('account:clearing', head)).balance, 0, 'clearing balance reversed');
  assert.equal((await store.getAt('settle:s1', head)).status, 'CANCELLED');

  const reversal = await store.getAt('reversal:s1', head);
  assert.equal(reversal.slip, 'settle:s1');
  assert.deepEqual(reversal.entries, [
    { account: 'm1', side: 'debit', amount: 100 },
    { account: 'clearing', side: 'credit', amount: 100 },
  ]);

  // History preserved: at v1 the slip was still OPEN with posted balances.
  assert.equal((await store.getAt('settle:s1', v1)).status, 'OPEN');
  assert.equal((await store.getAt('account:m1', v1)).balance, 100);
  assert.equal(await store.getAt('reversal:s1', v1), undefined);
});

test('acceptance 2: two concurrent cancels of one OPEN slip - exactly one wins, three orderings', async (t) => {
  async function race(name, commitOrder) {
    await t.test(name, async () => {
      const store = new Store(tmpDir());
      await setupOpenSlip(store);

      const txA = await store.begin();
      const txB = await store.begin();
      await cancelSlip(txA, 's1');
      await cancelSlip(txB, 's1');

      const results = { A: null, B: null };
      if (commitOrder === 'A-then-B') {
        results.A = await txA.commit().then((r) => ({ ok: r }), (e) => ({ err: e }));
        results.B = await txB.commit().then((r) => ({ ok: r }), (e) => ({ err: e }));
      } else if (commitOrder === 'B-then-A') {
        results.B = await txB.commit().then((r) => ({ ok: r }), (e) => ({ err: e }));
        results.A = await txA.commit().then((r) => ({ ok: r }), (e) => ({ err: e }));
      } else {
        const [ra, rb] = await Promise.all([
          txA.commit().then((r) => ({ ok: r }), (e) => ({ err: e })),
          txB.commit().then((r) => ({ ok: r }), (e) => ({ err: e })),
        ]);
        results.A = ra;
        results.B = rb;
      }

      const winners = ['A', 'B'].filter((k) => results[k].ok);
      const losers = ['A', 'B'].filter((k) => results[k].err);
      assert.equal(winners.length, 1, `exactly one winner, got ${JSON.stringify(results)}`);
      assert.equal(losers.length, 1);
      assert.equal(results[losers[0]].err.code, 'E_CONFLICT');

      // Final state is consistent: one reversal, CANCELLED slip, zeroed balances.
      const head = await store.currentVersion();
      assert.equal(head, 2, 'exactly one cancel committed');
      assert.equal((await store.getAt('settle:s1', head)).status, 'CANCELLED');
      assert.equal((await store.getAt('account:m1', head)).balance, 0);
      assert.ok(await store.getAt('reversal:s1', head));
    });
  }

  await race('A commits first, B conflicts', 'A-then-B');
  await race('B commits first, A conflicts', 'B-then-A');
  await race('simultaneous commits, exactly one wins', 'simultaneous');
});

test('acceptance 3: cancel decided on stale snapshot, slip settled before commit - fails atomically', async () => {
  const store = new Store(tmpDir());
  await setupOpenSlip(store);

  const staleTx = await store.begin(); // snapshot: slip OPEN
  await cancelSlip(staleTx, 's1'); // decision made against the old snapshot

  // Meanwhile another transaction settles the slip.
  const settleTx = await store.begin();
  settleTx.put('settle:s1', { id: 's1', merchant: 'm1', amount: 100, status: 'SETTLED' });
  settleTx.put('account:m1', { balance: 100 });
  await settleTx.commit();

  await assert.rejects(staleTx.commit(), (err) => err.code === 'E_CONFLICT');

  // No half-posted reversal: no reversal record, slip still SETTLED,
  // balances exactly as the settle transaction left them.
  const head = await store.currentVersion();
  assert.equal(await store.getAt('reversal:s1', head), undefined, 'no reversal record');
  assert.equal((await store.getAt('settle:s1', head)).status, 'SETTLED');
  assert.equal((await store.getAt('account:m1', head)).balance, 100);
  assert.equal((await store.getAt('account:clearing', head)).balance, -100);
});

test('cancel of missing or non-OPEN slip fails with domain errors', async () => {
  const store = new Store(tmpDir());
  await setupOpenSlip(store);

  const missing = await store.begin();
  await assert.rejects(cancelSlip(missing, 'nope'), (err) => err.code === 'E_NOT_FOUND');

  const t1 = await store.begin();
  await cancelSlip(t1, 's1');
  await t1.commit();

  const again = await store.begin();
  await assert.rejects(cancelSlip(again, 's1'), (err) => err.code === 'E_INVALID_STATE');
});

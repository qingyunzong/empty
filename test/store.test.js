'use strict';
// Acceptance 2: crash between balance commit and frozen commit recovers to a
// consistent rollback on both sides.
// Acceptance 3: two concurrent refunds on the same sale — exactly one wins,
// the loser gets a conflict certificate; no automatic splitting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { ERR, guard, hashState } = require('../src/model');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
}

test('crash after balance commit, before frozen commit: recovery rolls back both sides', () => {
  const dir = tmpdir();
  const store = new Store(dir);
  assert.equal(store.commit([{ type: 'sale', id: 's1', account: 'a', amount: 100 }]).ok, true);
  const before = store.load();
  assert.throws(
    () =>
      store.commit([{ type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 40 }], {
        onCrash: (point) => {
          if (point === 'balance') throw new Error('SIMULATED CRASH');
        },
      }),
    /SIMULATED CRASH/
  );
  // Mid-crash: balance ledger moved, frozen ledger did not — inconsistent.
  const crashedBalance = JSON.parse(fs.readFileSync(path.join(dir, 'balance.json'), 'utf8'));
  const crashedFrozen = JSON.parse(fs.readFileSync(path.join(dir, 'frozen.json'), 'utf8'));
  assert.equal(crashedBalance.a, 60);
  assert.equal(crashedFrozen.a, 100);
  const reopened = new Store(dir);
  const report = reopened.recover();
  assert.equal(report.recovered, true);
  // Both sides consistently rolled back to the pre-transaction state.
  assert.deepStrictEqual(reopened.load(), before);
  const balance = JSON.parse(fs.readFileSync(path.join(dir, 'balance.json'), 'utf8'));
  const frozen = JSON.parse(fs.readFileSync(path.join(dir, 'frozen.json'), 'utf8'));
  assert.equal(balance.a, 100);
  assert.equal(frozen.a, 100);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8')).rolledBack, true);
  // System stays usable: the same refund commits cleanly after recovery.
  const res = reopened.commit([{ type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 40 }]);
  assert.equal(res.ok, true);
  assert.deepStrictEqual(reopened.load().accounts.a, { balance: 60, frozen: 60 });
});

test('recovery is a no-op after a clean commit', () => {
  const dir = tmpdir();
  const store = new Store(dir);
  store.commit([{ type: 'sale', id: 's1', account: 'a', amount: 10 }]);
  assert.deepStrictEqual(new Store(dir).recover(), { recovered: false });
  assert.deepStrictEqual(new Store(dir).load().accounts.a, { balance: 10, frozen: 10 });
});

test('two concurrent refunds on one sale: exactly one wins, loser gets conflict certificate', () => {
  const dir = tmpdir();
  const store = new Store(dir);
  store.commit([{ type: 'sale', id: 's1', account: 'a', amount: 100 }]);
  const base = hashState(store.load());
  const r1 = { type: 'refund', id: 'r1', saleId: 's1', account: 'a', amount: 60 };
  const r2 = { type: 'refund', id: 'r2', saleId: 's1', account: 'a', amount: 60 };
  // Both refunds validate against the same base state (combined 120 > 100).
  assert.equal(guard(store.load(), r1).ok, true);
  assert.equal(guard(store.load(), r2).ok, true);
  const res1 = store.commit([r1], { expectedHash: base });
  assert.equal(res1.ok, true);
  // Loser: optimistic-concurrency conflict certificate.
  const res2 = store.commit([r2], { expectedHash: base });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, ERR.DUPLICATE_REFUND);
  assert.equal(res2.certificate.expectedHash, base);
  assert.equal(res2.certificate.actualHash, res1.hash);
  // Loser retried against the new state: over-refund, still code 31, no split.
  const res2retry = store.commit([r2]);
  assert.equal(res2retry.ok, false);
  assert.equal(res2retry.code, ERR.DUPLICATE_REFUND);
  const final = store.load();
  assert.equal(final.sales.s1.refunded, 60, 'only the winning refund applied; no auto-split to 100');
  assert.equal(final.refunds.r2, undefined);
  assert.deepStrictEqual(final.accounts.a, { balance: 40, frozen: 40 });
});

test('rejected commit writes nothing', () => {
  const dir = tmpdir();
  const store = new Store(dir);
  store.commit([{ type: 'sale', id: 's1', account: 'a', amount: 50 }]);
  const before = store.load();
  const res = store.commit([{ type: 'refund', id: 'r1', saleId: 'ghost', account: 'a', amount: 10 }]);
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.DANGLING_REF);
  assert.deepStrictEqual(store.load(), before);
});

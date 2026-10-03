import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StoreError } from '../src/store.js';
import { openSlip, settleSlip, cancelSlip } from '../src/settlement.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-dom-'));
}

function freshStoreWithSlip() {
  const store = Store.open(tmpdir());
  const tx = store.begin();
  openSlip(tx, { id: 's1', merchantId: 'm1', amount: 100 });
  const v = tx.commit();
  return { store, v };
}

// Acceptance 1: serial settle + cancel. Balance, slip status and the
// debit/credit reversal entries must all be correct, with history preserved.
test('serial settle then cancel: balance, status, reversal entries', () => {
  const store = Store.open(tmpdir());

  let tx = store.begin();
  openSlip(tx, { id: 's1', merchantId: 'm1', amount: 100 });
  openSlip(tx, { id: 's2', merchantId: 'm1', amount: 40 });
  const v1 = tx.commit();

  tx = store.begin();
  settleSlip(tx, 's1');
  const v2 = tx.commit();

  tx = store.begin();
  cancelSlip(tx, 's2');
  const v3 = tx.commit();

  const head = store.head();
  assert.equal(head, v3);

  // Balance reflects only the settled slip; the cancelled one never touched it.
  assert.deepEqual(store.readAt('acct:m1', head), { merchantId: 'm1', balance: 100 });
  assert.equal(store.readAt('settle:s1', head).status, 'SETTLED');
  assert.equal(store.readAt('settle:s2', head).status, 'CANCELLED');

  // Reversal record and both debit/credit legs exist for the cancelled slip.
  assert.deepEqual(store.readAt('reversal:s2', head), {
    kind: 'cancel',
    slipId: 's2',
    merchantId: 'm1',
    amount: 40,
  });
  assert.deepEqual(store.readAt('entry:s2:reversal:debit', head), {
    type: 'reversal', leg: 'debit', slipId: 's2', account: 'acct:m1', amount: -40,
  });
  assert.deepEqual(store.readAt('entry:s2:reversal:credit', head), {
    type: 'reversal', leg: 'credit', slipId: 's2', account: 'clearing:m1', amount: 40,
  });
  // Settle ledger entry for s1 exists; no reversal leaked onto s1.
  assert.equal(store.readAt('entry:s1:settle', head).amount, 100);
  assert.equal(store.readAt('reversal:s1', head), undefined);

  // History is preserved, not overwritten: older versions still readable.
  assert.equal(store.readAt('settle:s2', v1).status, 'OPEN');
  assert.equal(store.readAt('settle:s2', v2).status, 'OPEN');
  assert.equal(store.readAt('reversal:s2', v2), undefined);
  assert.equal(store.readAt('acct:m1', v1).balance, 0);
  assert.equal(store.readAt('acct:m1', v2).balance, 100);
});

// Acceptance 2: two concurrent transactions cancel the same OPEN slip.
// Enumerate three begin/commit orders; exactly one commit succeeds and the
// other fails with E_CONFLICT.
test('concurrent cancels of one OPEN slip: three commit orders', () => {
  const orders = [
    { begin: ['A', 'B'], commit: ['A', 'B'] },
    { begin: ['A', 'B'], commit: ['B', 'A'] },
    { begin: ['B', 'A'], commit: ['A', 'B'] },
  ];
  for (const order of orders) {
    const { store } = freshStoreWithSlip();
    const txs = {};
    for (const who of order.begin) {
      txs[who] = store.begin();
      cancelSlip(txs[who], 's1');
    }
    const results = {};
    for (const who of order.commit) {
      try {
        results[who] = { version: txs[who].commit() };
      } catch (e) {
        assert.ok(e instanceof StoreError);
        results[who] = { error: e.code };
      }
    }
    const outcomes = Object.values(results);
    const succeeded = outcomes.filter((r) => r.version !== undefined);
    const conflicted = outcomes.filter((r) => r.error === 'E_CONFLICT');
    assert.equal(succeeded.length, 1, `order ${JSON.stringify(order)}: exactly one success`);
    assert.equal(conflicted.length, 1, `order ${JSON.stringify(order)}: exactly one E_CONFLICT`);

    // Final state: exactly one reversal, slip CANCELLED, no duplicated legs.
    const head = store.head();
    assert.equal(store.readAt('settle:s1', head).status, 'CANCELLED');
    assert.equal(store.readAt('reversal:s1', head).slipId, 's1');
    assert.equal(store.readAt('entry:s1:reversal:debit', head).amount, -100);
    assert.equal(store.readAt('entry:s1:reversal:credit', head).amount, 100);
    assert.equal(store.readAt('acct:m1', head).balance, 0);
  }
});

// Acceptance 3: a transaction decides to cancel on a stale snapshot; the slip
// gets SETTLED before it commits. The cancel must fail and leave no partial
// reversal behind.
test('stale-snapshot cancel loses to a settle: no half reversal', () => {
  const { store, v: v1 } = freshStoreWithSlip();

  const stale = store.begin(); // snapshot v1, slip still OPEN there
  cancelSlip(stale, 's1'); // decision made against the old snapshot
  assert.equal(stale.snapshot, v1);

  const settler = store.begin();
  settleSlip(settler, 's1');
  const v2 = settler.commit();

  assert.throws(
    () => stale.commit(),
    (e) => e instanceof StoreError && e.code === 'E_CONFLICT',
  );

  // Nothing from the losing transaction was applied: no reversal record,
  // no reversal legs, slip remains SETTLED, balance credited exactly once.
  const head = store.head();
  assert.equal(head, v2);
  assert.equal(store.readAt('settle:s1', head).status, 'SETTLED');
  assert.equal(store.readAt('acct:m1', head).balance, 100);
  assert.equal(store.readAt('reversal:s1', head), undefined);
  assert.equal(store.readAt('entry:s1:reversal:debit', head), undefined);
  assert.equal(store.readAt('entry:s1:reversal:credit', head), undefined);
  assert.deepEqual(store.stateAt(head), store.stateAt(v2));
});

// A cancel attempted against an already-SETTLED slip fails with E_STATE and
// commits nothing at all (atomicity of the failing transaction).
test('cancel of a settled slip fails atomically with E_STATE', () => {
  const { store } = freshStoreWithSlip();
  const settler = store.begin();
  settleSlip(settler, 's1');
  settler.commit();

  const headBefore = store.head();
  const tx = store.begin();
  assert.throws(
    () => cancelSlip(tx, 's1'),
    (e) => e instanceof StoreError && e.code === 'E_STATE',
  );
  assert.equal(store.head(), headBefore);
  assert.equal(store.readAt('reversal:s1', store.head()), undefined);
});

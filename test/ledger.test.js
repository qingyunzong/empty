'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store, LedgerError } = require('../src/store');

function expectCode(fn, code) {
  assert.throws(
    fn,
    (err) => err instanceof LedgerError && err.code === code,
    `expected ${code}`,
  );
}

test('freeze then pay succeeds; over-limit gives E_INSUFFICIENT; boundary available=0', () => {
  const store = new Store();
  let tx = store.begin();
  tx.createAccount('A', 1000);
  tx.commit();

  // Freeze reduces available.
  tx = store.begin();
  const frozen = tx.freeze({ account: 'A', holdId: 'h1', amount: 400, dueDate: '2026-01-10' });
  assert.equal(frozen.available, 600);
  tx.commit();
  assert.equal(store.available('A'), 600);

  // Pay settles the hold: total is deducted, hold released (SETTLED).
  tx = store.begin();
  const paid = tx.pay({ holdId: 'h1', paymentId: 'p1' });
  assert.equal(paid.amount, 400);
  tx.commit();
  assert.equal(store.accounts.get('A').total, 600);
  assert.equal(store.holds.get('h1').status, 'SETTLED');
  assert.equal(store.payments.get('p1').status, 'PAID');
  assert.equal(store.available('A'), 600);

  // Boundary: freeze exactly the remaining quota, available becomes exactly 0.
  tx = store.begin();
  const edge = tx.freeze({ account: 'A', holdId: 'h2', amount: 600, dueDate: '2026-01-11' });
  assert.equal(edge.available, 0);
  tx.commit();
  assert.equal(store.available('A'), 0);

  // Available is exactly 0: any further freeze fails.
  tx = store.begin();
  expectCode(
    () => tx.freeze({ account: 'A', holdId: 'h3', amount: 1, dueDate: '2026-01-12' }),
    'E_INSUFFICIENT',
  );

  // Over-payment beyond hold + available fails; exact settle at boundary succeeds.
  expectCode(() => tx.pay({ holdId: 'h2', paymentId: 'p2', amount: 601 }), 'E_INSUFFICIENT');
  const settled = tx.pay({ holdId: 'h2', paymentId: 'p2', amount: 600 });
  assert.equal(settled.total, 0);
  tx.commit();
  assert.equal(store.accounts.get('A').total, 0);
  assert.equal(store.available('A'), 0);
});

test('over-payment covered by remaining available succeeds', () => {
  const store = new Store();
  let tx = store.begin();
  tx.createAccount('A', 1000);
  tx.freeze({ account: 'A', holdId: 'h1', amount: 400, dueDate: '2026-01-10' });
  tx.commit();

  tx = store.begin();
  const paid = tx.pay({ holdId: 'h1', paymentId: 'p1', amount: 1000 });
  assert.equal(paid.total, 0);
  tx.commit();
  assert.equal(store.accounts.get('A').total, 0);
});

function setupHeldAccount() {
  const store = new Store();
  const tx = store.begin();
  tx.createAccount('A', 500);
  tx.freeze({ account: 'A', holdId: 'h', amount: 200, dueDate: '2026-02-01' });
  tx.commit();
  return store;
}

test('concurrent release vs pay: only first committer wins, loser retries against new state', () => {
  // Commit order 1: release first, pay conflicts and retry sees RELEASED hold.
  {
    const store = setupHeldAccount();
    const txRelease = store.begin();
    const txPay = store.begin();
    txRelease.release({ holdId: 'h' });
    txPay.pay({ holdId: 'h', paymentId: 'p' });

    txRelease.commit();
    expectCode(() => txPay.commit(), 'E_CONFLICT');

    const retry = store.begin();
    expectCode(() => retry.pay({ holdId: 'h', paymentId: 'p' }), 'E_HOLD_STATE');

    assert.equal(store.holds.get('h').status, 'RELEASED');
    assert.equal(store.accounts.get('A').total, 500);
    assert.equal(store.available('A'), 500);
    assert.equal(store.payments.has('p'), false);
  }

  // Commit order 2: pay first, release conflicts and retry sees SETTLED hold.
  {
    const store = setupHeldAccount();
    const txRelease = store.begin();
    const txPay = store.begin();
    txRelease.release({ holdId: 'h' });
    txPay.pay({ holdId: 'h', paymentId: 'p' });

    txPay.commit();
    expectCode(() => txRelease.commit(), 'E_CONFLICT');

    const retry = store.begin();
    expectCode(() => retry.release({ holdId: 'h' }), 'E_HOLD_STATE');

    assert.equal(store.holds.get('h').status, 'SETTLED');
    assert.equal(store.accounts.get('A').total, 300);
    assert.equal(store.payments.get('p').status, 'PAID');
    assert.equal(store.available('A'), 300);
  }
});

test('secondary indexes match full-scan reference exactly, no stale state after cancel', () => {
  const store = new Store();
  let tx = store.begin();
  tx.createAccount('A', 100000);
  tx.createAccount('B', 100000);
  tx.createAccount('C', 100000);
  tx.commit();

  const accounts = ['A', 'B', 'C'];
  const dates = ['2026-01-01', '2026-01-15', '2026-02-01', '2026-03-01'];
  let seq = 0;
  for (const account of accounts) {
    for (const dueDate of dates) {
      for (const k of [0, 1]) {
        seq += 1;
        const t = store.begin();
        t.freeze({ account, holdId: `h${seq}`, amount: 100, dueDate });
        t.commit();
      }
    }
  }

  // Drive holds into every status: release h1..h4, settle h5..h8 via pay.
  for (const id of ['h1', 'h2', 'h3', 'h4']) {
    const t = store.begin();
    t.release({ holdId: id });
    t.commit();
  }
  for (const id of ['h5', 'h6', 'h7', 'h8']) {
    const t = store.begin();
    t.pay({ holdId: id, paymentId: `p_${id}` });
    t.commit();
  }

  const fullScan = (q) => [...store.holds.values()]
    .filter((h) => (q.account === undefined || h.account === q.account)
      && (q.status === undefined || h.status === q.status)
      && (q.dueBefore === undefined || h.dueDate < q.dueBefore))
    .map((h) => h.id)
    .sort();
  const indexQuery = (q) => store.queryHolds(q).map((h) => h.id);

  const queryMatrix = () => {
    for (const account of [undefined, 'A', 'B', 'C']) {
      for (const status of [undefined, 'HELD', 'RELEASED', 'SETTLED']) {
        for (const dueBefore of [undefined, '2026-01-16', '2026-02-02', '2027-01-01']) {
          const q = { account, status, dueBefore };
          assert.deepEqual(indexQuery(q), fullScan(q), `query ${JSON.stringify(q)}`);
        }
      }
    }
  };
  queryMatrix();

  // Cancel two payments: refunds generated, totals restored, indexes stay exact.
  const totalBefore = store.accounts.get('A').total;
  for (const pid of ['p_h5', 'p_h6']) {
    const t = store.begin();
    const refund = t.cancelPay({ paymentId: pid });
    assert.equal(refund.amount, 100);
    t.commit();
  }
  assert.equal(store.accounts.get('A').total, totalBefore + 200);
  assert.equal(store.payments.get('p_h5').status, 'CANCELLED');
  assert.ok(store.refunds.some((r) => r.paymentId === 'p_h5' && r.amount === 100));
  assert.ok(store.refunds.some((r) => r.paymentId === 'p_h6' && r.amount === 100));
  queryMatrix();

  // Release every remaining HELD hold: no stale HELD entries may survive.
  for (const hold of store.queryHolds({ status: 'HELD' })) {
    const t = store.begin();
    t.release({ holdId: hold.id });
    t.commit();
  }
  assert.deepEqual(store.queryHolds({ status: 'HELD' }), []);
  for (const key of store.idxAccountStatus.keys()) {
    assert.ok(!key.endsWith(' HELD'), `stale index key ${key}`);
  }
  assert.equal(store.idxDueStatus.has('HELD'), false);
  queryMatrix();
});

test('unknown account returns E_NO_ACCOUNT', () => {
  const store = new Store();
  const tx = store.begin();
  expectCode(
    () => tx.freeze({ account: 'GHOST', holdId: 'h1', amount: 10, dueDate: '2026-01-01' }),
    'E_NO_ACCOUNT',
  );
  expectCode(() => tx.available('GHOST'), 'E_NO_ACCOUNT');
  expectCode(() => store.available('GHOST'), 'E_NO_ACCOUNT');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { ERR } = require('../src/core');

// History: e1 open 10 -> e2 credit 100 -> e3 debit 105 -> e4 debit 2. Balance 3.
// Three-layer undo plan:
//   b1 (continue on child failure): targets [e3], children [b2]
//     b2: targets [e2]  (inverse -100 fails: balance would go negative)
//       b3: targets [e4] (inverse +2 succeeds, then rolled back with b2)
function buildLedger() {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 10 });
  ledger.apply({ id: 'e2', type: 'credit', account: 'a', amount: 100 });
  ledger.apply({ id: 'e3', type: 'debit', account: 'a', amount: 105 });
  ledger.apply({ id: 'e4', type: 'debit', account: 'a', amount: 2 });
  return ledger;
}

function makePlan(onChildFailure) {
  return {
    id: 'b1',
    onChildFailure,
    targets: ['e3'],
    children: [
      { id: 'b2', targets: ['e2'], children: [{ id: 'b3', targets: ['e4'] }] },
    ],
  };
}

test('C: three-layer batch, layer-2 failure rolls back locally, parent continues', () => {
  const ledger = buildLedger();
  const res = ledger.apply({ id: 'u1', type: 'undo', account: 'a', plan: makePlan('continue') });
  assert.equal(res.ok, true);
  // b3's inverse (+2) was rolled back together with failed b2; only e3 undone.
  assert.equal(ledger.summary().a.balance, 108); // 3 + 105
  const acc = ledger.accounts.get('a');
  assert.deepEqual([...acc.undone], ['e3']);

  const plan = res.plan;
  assert.equal(plan.id, 'b1');
  assert.equal(plan.status, 'ok');
  assert.deepEqual(plan.ops, [{ op: 'credit', target: 'e3', amount: 105 }]);
  const b2 = plan.children[0];
  assert.equal(b2.status, 'failed');
  assert.equal(b2.error.code, ERR.NEGATIVE);
  assert.equal(b2.error.target, 'e2');
  assert.equal(b2.children[0].id, 'b3');
  assert.equal(b2.children[0].status, 'ok'); // executed, then rolled back with b2
});

test('C: abort policy rolls back the whole batch deterministically', () => {
  const ledger = buildLedger();
  const res = ledger.apply({ id: 'u1', type: 'undo', account: 'a', plan: makePlan('abort') });
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.NEGATIVE);
  assert.equal(ledger.summary().a.balance, 3); // fully rolled back
  assert.deepEqual([...ledger.accounts.get('a').undone], []);
});

test('C: batch undo result is deterministic across runs', () => {
  const run = () => {
    const ledger = buildLedger();
    ledger.apply({ id: 'u1', type: 'undo', account: 'a', plan: makePlan('continue') });
    return { summary: ledger.summary(), plans: ledger.undoPlans, errors: ledger.errors };
  };
  assert.deepEqual(run(), run());
});

test('C: single-target undo applies the inverse operation', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 50 });
  ledger.apply({ id: 'e2', type: 'debit', account: 'a', amount: 20 });
  const res = ledger.apply({ id: 'u1', type: 'undo', account: 'a', target: 'e2' });
  assert.equal(res.ok, true);
  assert.equal(ledger.summary().a.balance, 50);
  assert.deepEqual(ledger.undoPlans[0].result.ops, [{ op: 'credit', target: 'e2', amount: 20 }]);

  // undo of a credit whose funds were spent fails with NEGATIVE and changes nothing
  ledger.apply({ id: 'e3', type: 'credit', account: 'a', amount: 40 });
  ledger.apply({ id: 'e4', type: 'debit', account: 'a', amount: 85 });
  const fail = ledger.apply({ id: 'u2', type: 'undo', account: 'a', target: 'e3' });
  assert.equal(fail.ok, false);
  assert.equal(fail.code, ERR.NEGATIVE);
  assert.equal(ledger.summary().a.balance, 5);
});

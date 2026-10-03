import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStep, checkInvariants, hashState, initialState } from '../src/state.js';
import { normalizePlan } from '../src/plan.js';

function makePlan() {
  return normalizePlan({
    accounts: [
      { id: 'A', balance: 100 },
      { id: 'B', balance: 0 },
    ],
    actors: [
      {
        id: 'alice',
        steps: [
          { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 40 },
          { id: 'c1', type: 'commit', transfer: 't1' },
        ],
      },
      { id: 'dave', steps: [{ id: 'x1', type: 'cancel', transfer: 't1' }] },
    ],
  });
}

function ledgerOf(state) {
  const { rejected, ...ledger } = state;
  return ledger;
}

test('reserve freezes quota, commit posts and releases the hold', () => {
  const plan = makePlan();
  const state = initialState(plan);
  assert.equal(applyStep(state, plan.actors[0].steps[0]), null);
  assert.equal(state.frozen.A, 40);
  assert.deepEqual(state.holds.t1, { from: 'A', to: 'B', amount: 40 });
  assert.equal(applyStep(state, plan.actors[0].steps[1]), null);
  assert.deepEqual(state.balances, { A: 60, B: 40 });
  assert.equal(state.frozen.A, 0);
  assert.deepEqual(state.holds, {});
  assert.deepEqual(checkInvariants(state, plan.initialTotal), []);
});

test('cancel before commit restores the frozen amount', () => {
  const plan = makePlan();
  const state = initialState(plan);
  applyStep(state, plan.actors[0].steps[0]);
  assert.equal(applyStep(state, plan.actors[1].steps[0]), null);
  assert.deepEqual(state.balances, { A: 100, B: 0 });
  assert.equal(state.frozen.A, 0);
  assert.deepEqual(state.holds, {});
  assert.deepEqual(checkInvariants(state, plan.initialTotal), []);
});

test('duplicate cancel is rejected and leaves the state unchanged', () => {
  const plan = makePlan();
  const state = initialState(plan);
  applyStep(state, plan.actors[0].steps[0]);
  applyStep(state, plan.actors[1].steps[0]);
  const before = ledgerOf(structuredClone(state));
  const reason = applyStep(state, { id: 'x2', type: 'cancel', transfer: 't1' });
  assert.equal(reason, 'NO_PENDING_HOLD');
  assert.deepEqual(ledgerOf(state), before);
  assert.deepEqual(state.rejected, [{ step: 'x2', reason: 'NO_PENDING_HOLD' }]);
});

test('cancel of an unknown transfer is rejected and leaves the state unchanged', () => {
  const plan = makePlan();
  const state = initialState(plan);
  applyStep(state, plan.actors[0].steps[0]);
  const before = ledgerOf(structuredClone(state));
  const reason = applyStep(state, { id: 'x9', type: 'cancel', transfer: 'nope' });
  assert.equal(reason, 'NO_PENDING_HOLD');
  assert.deepEqual(ledgerOf(state), before);
});

test('reserve on a frozen account is rejected and leaves the state unchanged', () => {
  const plan = makePlan();
  const state = initialState(plan);
  applyStep(state, { id: 'f1', type: 'freeze', account: 'A' });
  const before = ledgerOf(structuredClone(state));
  const reason = applyStep(state, plan.actors[0].steps[0]);
  assert.equal(reason, 'ACCOUNT_FROZEN');
  assert.deepEqual(ledgerOf(state), before);
});

test('reserve beyond the posted balance is rejected', () => {
  const plan = makePlan();
  const state = initialState(plan);
  const reason = applyStep(state, { id: 'r9', type: 'reserve', transfer: 't9', from: 'A', to: 'B', amount: 500 });
  assert.equal(reason, 'INSUFFICIENT_FUNDS');
  assert.equal(state.frozen.A, 0);
});

test('invariant checks detect over-hold, negative balance and conservation breaks', () => {
  const plan = makePlan();
  const state = initialState(plan);
  state.frozen.A = 150;
  state.holds.t1 = { from: 'A', to: 'B', amount: 150 };
  const violations = checkInvariants(state, plan.initialTotal).map((v) => v.type);
  assert.ok(violations.includes('HOLD_EXCEEDS_AVAILABLE'));

  const broken = initialState(plan);
  broken.balances.A -= 1;
  assert.ok(checkInvariants(broken, plan.initialTotal).some((v) => v.type === 'CONSERVATION'));

  const negative = initialState(plan);
  negative.balances.B = -5;
  negative.balances.A += 5;
  assert.ok(checkInvariants(negative, plan.initialTotal).some((v) => v.type === 'NEGATIVE_BALANCE'));
});

test('state hashing is canonical and reproducible', () => {
  const plan = makePlan();
  const a = initialState(plan);
  const b = initialState(plan);
  applyStep(a, plan.actors[0].steps[0]);
  applyStep(b, plan.actors[0].steps[0]);
  assert.equal(hashState(a), hashState(b));
  applyStep(b, plan.actors[0].steps[1]);
  assert.notEqual(hashState(a), hashState(b));
});

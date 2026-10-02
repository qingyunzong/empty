'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXIT_OK,
  EXIT_ILLEGAL_TRANSITION,
  EXIT_AMOUNT_OUT_OF_RANGE,
  EXIT_UNKNOWN_COMMAND,
  initialState,
  getAccount,
  applyCommand,
  verifyState,
} = require('../src/machine');

function seeded() {
  const state = initialState();
  state.accounts = {
    A: { available: 1000, frozen: 0, frozenLocked: 0 },
    B: { available: 1000, frozen: 0, frozenLocked: 0 },
  };
  return state;
}

function totalMoney(state) {
  return Object.values(state.accounts)
    .reduce((sum, a) => sum + a.available + a.frozen, 0);
}

test('full reverse then reverseReversal restores funds and reaches terminal RESTORED', () => {
  const state = seeded();
  let r = applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 200 });
  assert.equal(r.code, EXIT_OK);
  assert.equal(getAccount(state, 'A').available, 800);
  assert.equal(getAccount(state, 'B').available, 1200);
  assert.equal(state.transactions.t1.status, 'POSTED');

  r = applyCommand(state, { type: 'reverse', txId: 't1' });
  assert.equal(r.code, EXIT_OK);
  assert.equal(state.transactions.t1.status, 'REVERSED');
  assert.equal(getAccount(state, 'A').available, 1000);
  assert.equal(getAccount(state, 'B').available, 1000);

  r = applyCommand(state, { type: 'reverseReversal', txId: 't1' });
  assert.equal(r.code, EXIT_OK);
  assert.equal(state.transactions.t1.status, 'RESTORED');
  assert.equal(getAccount(state, 'A').available, 800);
  assert.equal(getAccount(state, 'B').available, 1200);

  const transitions = state.migrations.map((m) => `${m.from}->${m.to}`);
  assert.deepEqual(transitions, ['PENDING->POSTED', 'POSTED->REVERSED', 'REVERSED->RESTORED']);
  for (const m of state.migrations) {
    assert.equal(typeof m.id, 'string');
    assert.equal(typeof m.amount, 'number');
    assert.match(m.hash, /^[0-9a-f]{64}$/);
    assert.ok('reason' in m);
  }
  assert.equal(totalMoney(state), 2000);
  assert.deepEqual(verifyState(state), { ok: true, errors: [] });
});

test('partial reverse boundaries: amount=0 and over-amount rejected, remainder stays POSTED', () => {
  const state = seeded();
  applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 200 });

  let r = applyCommand(state, { type: 'reverse', txId: 't1', amount: 0 });
  assert.equal(r.code, EXIT_AMOUNT_OUT_OF_RANGE);
  r = applyCommand(state, { type: 'reverse', txId: 't1', amount: -5 });
  assert.equal(r.code, EXIT_AMOUNT_OUT_OF_RANGE);
  r = applyCommand(state, { type: 'reverse', txId: 't1', amount: 201 });
  assert.equal(r.code, EXIT_AMOUNT_OUT_OF_RANGE);
  assert.equal(state.transactions.t1.status, 'POSTED');
  assert.equal(state.transactions.t1.reversedAmount, 0);

  r = applyCommand(state, { type: 'reverse', txId: 't1', amount: 50 });
  assert.equal(r.code, EXIT_OK);
  assert.equal(state.transactions.t1.status, 'POSTED');
  assert.equal(state.transactions.t1.reversedAmount, 50);
  assert.equal(getAccount(state, 'A').available, 850);
  assert.equal(getAccount(state, 'B').available, 1150);

  r = applyCommand(state, { type: 'reverse', txId: 't1', amount: 151 });
  assert.equal(r.code, EXIT_AMOUNT_OUT_OF_RANGE);

  r = applyCommand(state, { type: 'reverse', txId: 't1', amount: 150 });
  assert.equal(r.code, EXIT_OK);
  assert.equal(state.transactions.t1.status, 'REVERSED');
  assert.equal(getAccount(state, 'A').available, 1000);
  assert.equal(getAccount(state, 'B').available, 1000);
  assert.equal(totalMoney(state), 2000);
});

test('terminal RESTORED rejects further reverse/reverseReversal; illegal transitions exit 15', () => {
  const state = seeded();
  applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 100 });

  let r = applyCommand(state, { type: 'reverseReversal', txId: 't1' });
  assert.equal(r.code, EXIT_ILLEGAL_TRANSITION);

  r = applyCommand(state, { type: 'reverse', txId: 'nope' });
  assert.equal(r.code, EXIT_ILLEGAL_TRANSITION);

  applyCommand(state, { type: 'reverse', txId: 't1' });
  r = applyCommand(state, { type: 'reverse', txId: 't1' });
  assert.equal(r.code, EXIT_ILLEGAL_TRANSITION);

  applyCommand(state, { type: 'reverseReversal', txId: 't1' });
  assert.equal(state.transactions.t1.status, 'RESTORED');
  r = applyCommand(state, { type: 'reverse', txId: 't1' });
  assert.equal(r.code, EXIT_ILLEGAL_TRANSITION);
  r = applyCommand(state, { type: 'reverseReversal', txId: 't1' });
  assert.equal(r.code, EXIT_ILLEGAL_TRANSITION);

  r = applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 1 });
  assert.equal(r.code, EXIT_ILLEGAL_TRANSITION);
});

test('freeze and reverse interleave without overdraft; unfreeze cannot release reversal-locked share', () => {
  const state = seeded();
  applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 200 });
  // B: available 1200

  let r = applyCommand(state, { type: 'freeze', account: 'B', amount: 1100 });
  assert.equal(r.code, EXIT_OK);
  assert.deepEqual(getAccount(state, 'B'), { available: 100, frozen: 1100, frozenLocked: 0 });

  // Reverse draws available first, then frozen.
  r = applyCommand(state, { type: 'reverse', txId: 't1' });
  assert.equal(r.code, EXIT_OK);
  assert.deepEqual(getAccount(state, 'B'), { available: 0, frozen: 1000, frozenLocked: 0 });
  assert.equal(getAccount(state, 'A').available, 1000);

  // Reversal-compensation freeze locks the share.
  r = applyCommand(state, {
    type: 'freeze', account: 'A', amount: 500, reason: 'reversal-compensation',
  });
  assert.equal(r.code, EXIT_OK);
  assert.deepEqual(getAccount(state, 'A'), { available: 500, frozen: 500, frozenLocked: 500 });

  r = applyCommand(state, { type: 'unfreeze', account: 'A', amount: 1 });
  assert.equal(r.code, EXIT_AMOUNT_OUT_OF_RANGE);
  assert.equal(getAccount(state, 'A').frozen, 500);

  // Unfreeze beyond releasable share on B is fine up to frozen.
  r = applyCommand(state, { type: 'unfreeze', account: 'B', amount: 1001 });
  assert.equal(r.code, EXIT_AMOUNT_OUT_OF_RANGE);
  r = applyCommand(state, { type: 'unfreeze', account: 'B', amount: 1000 });
  assert.equal(r.code, EXIT_OK);
  assert.deepEqual(getAccount(state, 'B'), { available: 1000, frozen: 0, frozenLocked: 0 });

  // Freeze cannot exceed available.
  r = applyCommand(state, { type: 'freeze', account: 'B', amount: 1001 });
  assert.equal(r.code, EXIT_AMOUNT_OUT_OF_RANGE);

  assert.equal(totalMoney(state), 2000);
  assert.deepEqual(verifyState(state), { ok: true, errors: [] });
});

test('reverse consumes locked frozen shares when nothing else is available', () => {
  const state = seeded();
  applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 300 });
  applyCommand(state, {
    type: 'freeze', account: 'B', amount: 1200, reason: 'reversal-compensation',
  });
  assert.deepEqual(getAccount(state, 'B'), { available: 100, frozen: 1200, frozenLocked: 1200 });

  const r = applyCommand(state, { type: 'reverse', txId: 't1' });
  assert.equal(r.code, EXIT_OK);
  assert.deepEqual(getAccount(state, 'B'), { available: 0, frozen: 1000, frozenLocked: 1000 });
  assert.equal(getAccount(state, 'A').available, 1000);
  assert.equal(totalMoney(state), 2000);
});

test('reverseReversal restores frozen/locked shares exactly as settled', () => {
  const state = seeded();
  applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 200 });
  applyCommand(state, { type: 'freeze', account: 'B', amount: 1150 });
  applyCommand(state, { type: 'reverse', txId: 't1' });
  // B paid 50 available + 150 frozen.
  assert.deepEqual(getAccount(state, 'B'), { available: 0, frozen: 1000, frozenLocked: 0 });

  const r = applyCommand(state, { type: 'reverseReversal', txId: 't1' });
  assert.equal(r.code, EXIT_OK);
  assert.deepEqual(getAccount(state, 'B'), { available: 50, frozen: 1150, frozenLocked: 0 });
  assert.equal(getAccount(state, 'A').available, 800);
  assert.equal(totalMoney(state), 2000);
  assert.deepEqual(verifyState(state), { ok: true, errors: [] });
});

test('idempotencyKey replays return the original result without re-applying', () => {
  const state = seeded();
  const cmd = { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 100, idempotencyKey: 'k1' };
  const r1 = applyCommand(state, cmd);
  assert.equal(r1.code, EXIT_OK);
  const migrationsAfter = state.migrations.length;

  const r2 = applyCommand(state, cmd);
  assert.equal(r2.code, EXIT_OK);
  assert.equal(r2.replayed, true);
  assert.equal(state.migrations.length, migrationsAfter);
  assert.equal(getAccount(state, 'A').available, 900);
  assert.equal(getAccount(state, 'B').available, 1100);

  // Failed commands are also idempotent.
  const bad = { type: 'reverse', txId: 't1', amount: 0, idempotencyKey: 'k2' };
  const e1 = applyCommand(state, bad);
  assert.equal(e1.code, EXIT_AMOUNT_OUT_OF_RANGE);
  const e2 = applyCommand(state, bad);
  assert.equal(e2.code, EXIT_AMOUNT_OUT_OF_RANGE);
  assert.equal(e2.replayed, true);
  assert.equal(e2.error, e1.error);
});

test('unknown command exits 17 and malformed commands are rejected', () => {
  const state = seeded();
  assert.equal(applyCommand(state, { type: 'teleport' }).code, EXIT_UNKNOWN_COMMAND);
  assert.equal(applyCommand(state, {}).code, EXIT_UNKNOWN_COMMAND);
  assert.equal(applyCommand(state, null).code, EXIT_UNKNOWN_COMMAND);
  assert.equal(applyCommand(state, { type: 'transfer' }).code, EXIT_AMOUNT_OUT_OF_RANGE);
});

test('hash chain detects tampering', () => {
  const state = seeded();
  applyCommand(state, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 100 });
  applyCommand(state, { type: 'reverse', txId: 't1' });
  assert.equal(verifyState(state).ok, true);

  state.migrations[0].amount = 999;
  const report = verifyState(state);
  assert.equal(report.ok, false);
  assert.ok(report.errors.length > 0);
});

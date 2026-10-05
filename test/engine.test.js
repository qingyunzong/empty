'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

function run(engine, ops) {
  return ops.map((op) => engine.apply(op));
}

test('deposit/withdraw/transfer/freeze/unfreeze basics', () => {
  const e = new Engine();
  run(e, [
    { op: 'deposit', account: 'a', amount: 100 },
    { op: 'freeze', account: 'a', amount: 30 },
    { op: 'withdraw', account: 'a', amount: 20 },
    { op: 'transfer', from: 'a', to: 'b', amount: 50 },
    { op: 'unfreeze', account: 'a', amount: 30 },
  ]).forEach((r) => assert.equal(r.status, 'ok', JSON.stringify(r)));
  const s = e.snapshotState();
  assert.deepEqual(s.accounts.a, { balance: 30, frozen: 0 });
  assert.deepEqual(s.accounts.b, { balance: 50, frozen: 0 });
});

test('INSUFFICIENT: withdraw/transfer/freeze/unfreeze limits', () => {
  const e = new Engine();
  run(e, [
    { op: 'deposit', account: 'a', amount: 100 },
    { op: 'freeze', account: 'a', amount: 60 },
  ]);
  // only 40 available
  assert.equal(e.apply({ op: 'withdraw', account: 'a', amount: 41 }).error.code, 'INSUFFICIENT');
  assert.equal(e.apply({ op: 'transfer', from: 'a', to: 'b', amount: 41 }).error.code, 'INSUFFICIENT');
  assert.equal(e.apply({ op: 'freeze', account: 'a', amount: 41 }).error.code, 'INSUFFICIENT');
  assert.equal(e.apply({ op: 'unfreeze', account: 'a', amount: 61 }).error.code, 'INSUFFICIENT');
  // failures leave state untouched
  assert.deepEqual(e.snapshotState().accounts.a, { balance: 100, frozen: 60 });
});

test('INVARIANT: day budget cannot go negative', () => {
  const e = new Engine({ budget: { day: 50 } });
  const r = e.apply({ op: 'deposit', account: 'a', amount: 60 });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'INVARIANT');
  assert.deepEqual(r.state.accounts, {});
  assert.equal(r.state.budget.day, 50);
});

test('budget is consumed by money ops and refunded by undo', () => {
  const e = new Engine({ budget: { day: 100 } });
  e.apply({ op: 'deposit', account: 'a', amount: 60 });
  e.apply({ op: 'transfer', from: 'a', to: 'b', amount: 25 });
  assert.equal(e.snapshotState().budget.day, 15);
  e.apply({ op: 'undo' }); // undo transfer
  assert.equal(e.snapshotState().budget.day, 40);
  e.apply({ op: 'undo' }); // undo deposit
  assert.equal(e.snapshotState().budget.day, 100);
  assert.deepEqual(e.snapshotState().accounts, {});
});

test('BATCH_NESTING: end without begin, begin inside begin, undo inside batch', () => {
  const e = new Engine();
  assert.equal(e.apply({ op: 'batchEnd' }).error.code, 'BATCH_NESTING');
  e.apply({ op: 'batchBegin', id: 'x' });
  assert.equal(e.apply({ op: 'batchBegin', id: 'y' }).error.code, 'BATCH_NESTING');
  assert.equal(e.apply({ op: 'undo' }).error.code, 'BATCH_NESTING');
  assert.equal(e.apply({ op: 'batchEnd', id: 'wrong' }).error.code, 'BATCH_NESTING');
  assert.equal(e.apply({ op: 'batchEnd', id: 'x' }).status, 'ok');
});

test('UNDO_GAP: empty stack, unknown or already-undone batch', () => {
  const e = new Engine();
  assert.equal(e.apply({ op: 'undo' }).error.code, 'UNDO_GAP');
  run(e, [
    { op: 'batchBegin', id: 'b1' },
    { op: 'deposit', account: 'a', amount: 10 },
    { op: 'batchEnd', id: 'b1' },
  ]);
  assert.equal(e.apply({ op: 'undo', batch: 'nope' }).error.code, 'UNDO_GAP');
  assert.equal(e.apply({ op: 'undo', batch: 'b1' }).status, 'ok');
  assert.equal(e.apply({ op: 'undo', batch: 'b1' }).error.code, 'UNDO_GAP');
  assert.equal(e.apply({ op: 'undo' }).error.code, 'UNDO_GAP');
});

test('undo top restores exact previous state', () => {
  const e = new Engine();
  e.apply({ op: 'deposit', account: 'a', amount: 100 });
  const before = e.snapshotState();
  e.apply({ op: 'transfer', from: 'a', to: 'b', amount: 40 });
  e.apply({ op: 'undo' });
  assert.deepEqual(e.snapshotState(), before);
});

test('cross-batch undo expands to deterministic reverse-time sequence', () => {
  const e = new Engine();
  run(e, [
    { op: 'batchBegin', id: 'b1' },
    { op: 'deposit', account: 'a', amount: 100 },
    { op: 'batchEnd', id: 'b1' },
    { op: 'deposit', account: 'b', amount: 50 }, // standalone unit u2
  ]);
  const r = e.apply({ op: 'undo', batch: 'b1' });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  // event-time-descending tie-break: undo the newer unit (u2) first
  assert.deepEqual(
    r.undoPlan.steps.map((s) => [s.op, s.account, s.amount, s.event]),
    [
      ['withdraw', 'b', 50, 2],
      ['withdraw', 'a', 100, 1],
    ]
  );
  assert.deepEqual(e.snapshotState().accounts, {});
  assert.equal(e.stack.length, 0);
});

test('undo legality: only orderings keeping invariants are valid plans', () => {
  const e = new Engine();
  run(e, [
    { op: 'batchBegin', id: 'b1' },
    { op: 'deposit', account: 'a', amount: 100 },
    { op: 'withdraw', account: 'a', amount: 80 }, // balance 20
    { op: 'batchEnd', id: 'b1' },
  ]);
  // inverses: deposit 80, withdraw 100. withdraw-first would break balance>=0
  // (20 - 100 < 0), so the only legal plan deposits 80 first.
  const r = e.apply({ op: 'undo' });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.deepEqual(
    r.undoPlan.steps.map((s) => [s.op, s.amount]),
    [
      ['deposit', 80],
      ['withdraw', 100],
    ]
  );
  assert.deepEqual(e.snapshotState().accounts, {});
});

test('zero-amount ops are no-ops and dropped from undo plans', () => {
  const e = new Engine();
  run(e, [
    { op: 'batchBegin', id: 'b1' },
    { op: 'deposit', account: 'a', amount: 0 },
    { op: 'deposit', account: 'b', amount: 10 },
    { op: 'batchEnd', id: 'b1' },
  ]);
  const r = e.apply({ op: 'undo' });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.undoPlan.steps.length, 1);
  assert.deepEqual(e.snapshotState().accounts, {});
});

test('duplicate inverse sequences are deduplicated (no false ambiguity)', () => {
  const e = new Engine();
  run(e, [
    { op: 'batchBegin', id: 'b1' },
    { op: 'deposit', account: 'a', amount: 10 },
    { op: 'deposit', account: 'a', amount: 10 },
    { op: 'batchEnd', id: 'b1' },
  ]);
  const r = e.apply({ op: 'undo' });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.undoPlan.steps.length, 2);
  assert.deepEqual(e.snapshotState().accounts, {});
});

test('INVALID: malformed ops', () => {
  const e = new Engine();
  assert.equal(e.apply(null).error.code, 'INVALID');
  assert.equal(e.apply({ op: 'deposit', account: 'a', amount: -5 }).error.code, 'INVALID');
  assert.equal(e.apply({ op: 'deposit', account: 'a' }).error.code, 'INVALID');
  assert.equal(e.apply({ op: 'transfer', from: 'a', to: 'a', amount: 1 }).error.code, 'INVALID');
  assert.equal(e.apply({ op: 'explode' }).error.code, 'INVALID');
});

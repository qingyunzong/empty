'use strict';

// Acceptance scenarios A, B, C, E from the task spec (D lives in
// test/enumeration.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

test('A: transfer + freeze combination commits successfully', () => {
  const e = new Engine({ budget: { day: 1000 } });
  const results = [
    { op: 'batchBegin', id: 'combo' },
    { op: 'deposit', account: 'alice', amount: 200 },
    { op: 'transfer', from: 'alice', to: 'bob', amount: 50 },
    { op: 'freeze', account: 'alice', amount: 30 },
    { op: 'batchEnd', id: 'combo' },
  ].map((op) => e.apply(op));
  results.forEach((r) => assert.equal(r.status, 'ok', JSON.stringify(r)));
  const s = e.snapshotState();
  assert.deepEqual(s.accounts.alice, { balance: 150, frozen: 30 });
  assert.deepEqual(s.accounts.bob, { balance: 50, frozen: 0 });
  assert.equal(s.budget.day, 750);
  assert.equal(e.stack.length, 1);
});

test('B: insufficient funds abort the whole batch with no partial effect', () => {
  const e = new Engine();
  e.apply({ op: 'batchBegin', id: 'b1' });
  e.apply({ op: 'deposit', account: 'a', amount: 100 });
  const failing = e.apply({ op: 'withdraw', account: 'a', amount: 999 });
  assert.equal(failing.status, 'error');
  assert.equal(failing.error.code, 'INSUFFICIENT');
  // deposit inside the batch was rolled back, nothing committed
  assert.deepEqual(e.snapshotState().accounts, {});
  assert.equal(e.stack.length, 0);
  // engine still usable afterwards
  const after = e.apply({ op: 'deposit', account: 'a', amount: 5 });
  assert.equal(after.status, 'ok');
  assert.deepEqual(e.snapshotState().accounts.a, { balance: 5, frozen: 0 });
});

test('C: nested batchBegin fails but the outer batch still commits', () => {
  const e = new Engine();
  e.apply({ op: 'batchBegin', id: 'outer' });
  e.apply({ op: 'deposit', account: 'a', amount: 100 });
  const nested = e.apply({ op: 'batchBegin', id: 'inner' });
  assert.equal(nested.status, 'error');
  assert.equal(nested.error.code, 'BATCH_NESTING');
  // outer batch is still open and accepts more ops
  e.apply({ op: 'deposit', account: 'b', amount: 50 });
  const commit = e.apply({ op: 'batchEnd', id: 'outer' });
  assert.equal(commit.status, 'ok');
  const s = e.snapshotState();
  assert.deepEqual(s.accounts.a, { balance: 100, frozen: 0 });
  assert.deepEqual(s.accounts.b, { balance: 50, frozen: 0 });
  assert.equal(e.stack.length, 1);
  assert.equal(e.stack[0].id, 'outer');
});

test('E: two equal-length, same-account, same-time plans trigger AMBIGUOUS_UNDO', () => {
  const e = new Engine();
  [
    { op: 'batchBegin', id: 'b1' },
    { op: 'deposit', account: 'a', amount: 100 },
    { op: 'deposit', account: 'b', amount: 100 },
    { op: 'batchEnd', id: 'b1' },
  ].forEach((op) => e.apply(op));
  // inverses withdraw(a,100) / withdraw(b,100) commute legally in both orders;
  // same length, same accounts, same batch event time -> genuine tie.
  const r = e.apply({ op: 'undo', batch: 'b1' });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'AMBIGUOUS_UNDO');
  assert.equal(r.undoPlan.ambiguous, true);
  assert.equal(r.undoPlan.candidates.length, 2);
  const serialized = r.undoPlan.candidates.map((c) => c.map((s) => s.op + ':' + s.account).join(','));
  assert.ok(serialized.includes('withdraw:a,withdraw:b'));
  assert.ok(serialized.includes('withdraw:b,withdraw:a'));
  // failed undo changes nothing; the unit stays on the stack
  assert.deepEqual(e.snapshotState().accounts.a, { balance: 100, frozen: 0 });
  assert.equal(e.stack.length, 1);
});

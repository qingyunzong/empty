import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

function run(ops, opts) {
  const ledger = new Ledger(opts);
  return ops.map((op) => ledger.execute(op));
}

test('A: transfer+freeze combo commits atomically and undoes in deterministic order', () => {
  const ledger = new Ledger({ budget: 1000 });
  const r1 = ledger.execute({ op: 'deposit', account: 'a', amount: 100 });
  assert.equal(r1.status, 'ok');
  assert.equal(ledger.execute({ op: 'batchBegin', id: 'T1' }).status, 'ok');
  assert.equal(ledger.execute({ op: 'transfer', from: 'a', to: 'b', amount: 40 }).status, 'ok');
  assert.equal(ledger.execute({ op: 'freeze', account: 'b', amount: 30 }).status, 'ok');
  const end = ledger.execute({ op: 'batchEnd' });
  assert.equal(end.status, 'ok');
  assert.equal(end.committed, 2);
  assert.deepEqual(end.state.accounts, { a: { balance: 60, frozen: 0 }, b: { balance: 40, frozen: 30 } });
  assert.equal(end.state.budget, 960);
  // undo plan of the batch: most-recent event first (freeze inverse, then transfer inverse)
  assert.equal(end.undoPlan.target, 'T1');
  assert.deepEqual(
    end.undoPlan.ops.map((o) => o.op),
    ['unfreeze', 'transfer'],
  );
  const u = ledger.execute({ op: 'undo' });
  assert.equal(u.status, 'ok');
  assert.equal(u.undone, 'T1');
  assert.deepEqual(u.state.accounts, { a: { balance: 100, frozen: 0 }, b: { balance: 0, frozen: 0 } });
  assert.equal(u.state.budget, 1000);
});

test('B: insufficient balance rolls back the whole batch with no partial effect', () => {
  const ledger = new Ledger({ budget: 1000 });
  ledger.execute({ op: 'deposit', account: 'a', amount: 50 });
  ledger.execute({ op: 'batchBegin', id: 'B1' });
  ledger.execute({ op: 'deposit', account: 'a', amount: 10 });
  const bad = ledger.execute({ op: 'withdraw', account: 'a', amount: 999 });
  assert.equal(bad.status, 'error');
  assert.equal(bad.error.code, 'INSUFFICIENT');
  const skipped = ledger.execute({ op: 'deposit', account: 'a', amount: 5 });
  assert.equal(skipped.status, 'skipped');
  const end = ledger.execute({ op: 'batchEnd' });
  assert.equal(end.status, 'error');
  assert.equal(end.error.code, 'INSUFFICIENT');
  assert.deepEqual(end.state.accounts, { a: { balance: 50, frozen: 0 } });
  // failed batch left no undoable unit; only the initial deposit remains
  assert.equal(end.undoPlan.target, 'U1');
});

test('C: failed inner/nested batch does not affect the committed outer batch', () => {
  const ledger = new Ledger({ budget: 1000 });
  ledger.execute({ op: 'batchBegin', id: 'OUTER' });
  ledger.execute({ op: 'deposit', account: 'a', amount: 100 });
  assert.equal(ledger.execute({ op: 'batchEnd' }).status, 'ok'); // OUTER committed
  ledger.execute({ op: 'batchBegin', id: 'INNER' });
  ledger.execute({ op: 'deposit', account: 'b', amount: 50 });
  const nested = ledger.execute({ op: 'batchBegin', id: 'NEST' });
  assert.equal(nested.status, 'error');
  assert.equal(nested.error.code, 'BATCH_NESTING');
  const fail = ledger.execute({ op: 'withdraw', account: 'a', amount: 10000 });
  assert.equal(fail.error.code, 'INSUFFICIENT');
  const end = ledger.execute({ op: 'batchEnd' });
  assert.equal(end.status, 'error');
  // INNER rolled back entirely (b never existed); committed OUTER untouched
  assert.deepEqual(end.state.accounts, { a: { balance: 100, frozen: 0 } });
  const u = ledger.execute({ op: 'undo' });
  assert.equal(u.undone, 'OUTER');
  assert.deepEqual(u.state.accounts, { a: { balance: 0, frozen: 0 } });
});

test('cross-batch undo expands into a deterministic inverse sequence', () => {
  const ledger = new Ledger({ budget: 1000 });
  ledger.execute({ op: 'deposit', account: 'a', amount: 100 }); // U1
  ledger.execute({ op: 'batchBegin', id: 'B1' });
  ledger.execute({ op: 'deposit', account: 'a', amount: 50 });
  ledger.execute({ op: 'batchEnd' });
  ledger.execute({ op: 'deposit', account: 'a', amount: 25 }); // U2
  assert.equal(ledger.getState().accounts.a.balance, 175);
  const u1 = ledger.execute({ op: 'undo', batch: 'B1' }); // not the stack top
  assert.equal(u1.status, 'ok');
  assert.deepEqual(u1.undoPlan.ops.map((o) => `${o.op}:${o.amount}`), ['withdraw:50']);
  assert.equal(ledger.getState().accounts.a.balance, 125);
  const u2 = ledger.execute({ op: 'undo' }); // top is now U2
  assert.equal(u2.undone, 'U2');
  const u3 = ledger.execute({ op: 'undo' });
  assert.equal(u3.undone, 'U1');
  assert.equal(ledger.getState().accounts.a.balance, 0);
  assert.equal(ledger.execute({ op: 'undo' }).error.code, 'UNDO_GAP');
  assert.equal(ledger.execute({ op: 'undo', batch: 'B1' }).error.code, 'UNDO_GAP'); // already undone
  assert.equal(ledger.execute({ op: 'undo', batch: 'NOPE' }).error.code, 'UNDO_GAP');
});

test('undo plan prefers fewest operations (consolidated inverse)', () => {
  const ledger = new Ledger({ budget: 1000 });
  ledger.execute({ op: 'deposit', account: 'a', amount: 100 });
  ledger.execute({ op: 'batchBegin', id: 'B1' });
  ledger.execute({ op: 'transfer', from: 'a', to: 'b', amount: 30 });
  ledger.execute({ op: 'transfer', from: 'a', to: 'b', amount: 20 });
  const end = ledger.execute({ op: 'batchEnd' });
  assert.equal(end.undoPlan.ops.length, 1);
  assert.deepEqual(end.undoPlan.ops[0].op, 'transfer');
  assert.equal(end.undoPlan.ops[0].amount, 50);
  const u = ledger.execute({ op: 'undo' });
  assert.deepEqual(u.state.accounts, { a: { balance: 100, frozen: 0 }, b: { balance: 0, frozen: 0 } });
});

test('event-time descending breaks ties between equal-length equal-account plans', () => {
  const ledger = new Ledger();
  ledger.execute({ op: 'batchBegin', id: 'B1' });
  ledger.execute({ op: 'deposit', account: 'a', amount: 10, ts: 1 });
  ledger.execute({ op: 'deposit', account: 'b', amount: 10, ts: 2 });
  const end = ledger.execute({ op: 'batchEnd' });
  assert.equal(end.undoPlan.status, 'OK');
  assert.deepEqual(
    end.undoPlan.ops.map((o) => o.account),
    ['b', 'a'], // newer event undone first
  );
});

test('E: two plans with same length, accounts and event times trigger AMBIGUOUS_UNDO', () => {
  const ledger = new Ledger();
  ledger.execute({ op: 'batchBegin', id: 'B1' });
  ledger.execute({ op: 'deposit', account: 'a', amount: 10, ts: 5 });
  ledger.execute({ op: 'deposit', account: 'b', amount: 10, ts: 5 });
  const end = ledger.execute({ op: 'batchEnd' });
  assert.equal(end.undoPlan.status, 'AMBIGUOUS');
  assert.equal(end.undoPlan.candidates.length, 2);
  const u = ledger.execute({ op: 'undo' });
  assert.equal(u.status, 'error');
  assert.equal(u.error.code, 'AMBIGUOUS_UNDO');
  assert.equal(u.error.details.plans.length, 2);
  // state untouched by the rejected undo
  assert.deepEqual(u.state.accounts, { a: { balance: 10, frozen: 0 }, b: { balance: 10, frozen: 0 } });
});

test('daily budget is enforced and restored by undo', () => {
  const ledger = new Ledger({ budget: 100 });
  ledger.execute({ op: 'deposit', account: 'a', amount: 200 });
  const w = ledger.execute({ op: 'withdraw', account: 'a', amount: 60 });
  assert.equal(w.state.budget, 40);
  const over = ledger.execute({ op: 'withdraw', account: 'a', amount: 50 });
  assert.equal(over.error.code, 'INVARIANT'); // day budget would go negative
  const u = ledger.execute({ op: 'undo' });
  assert.equal(u.state.budget, 100);
  assert.equal(u.state.accounts.a.balance, 200);
});

test('frozen invariants: frozen<=balance and frozen>=0 hold at every step', () => {
  const ledger = new Ledger();
  ledger.execute({ op: 'deposit', account: 'a', amount: 50 });
  assert.equal(ledger.execute({ op: 'freeze', account: 'a', amount: 50 }).status, 'ok');
  const w = ledger.execute({ op: 'withdraw', account: 'a', amount: 10 });
  assert.equal(w.error.code, 'INVARIANT'); // would leave frozen(50) > balance(40)
  const uf = ledger.execute({ op: 'unfreeze', account: 'a', amount: 60 });
  assert.equal(uf.error.code, 'INVARIANT'); // frozen would go negative
  assert.equal(ledger.execute({ op: 'unfreeze', account: 'a', amount: 20 }).status, 'ok');
  assert.equal(ledger.execute({ op: 'withdraw', account: 'a', amount: 20 }).status, 'ok');
  assert.deepEqual(ledger.getState().accounts.a, { balance: 30, frozen: 30 });
});

test('structural errors: batchEnd without batch, undo inside batch, invalid input', () => {
  const ledger = new Ledger();
  assert.equal(ledger.execute({ op: 'batchEnd' }).error.code, 'BATCH_NESTING');
  ledger.execute({ op: 'batchBegin', id: 'B1' });
  assert.equal(ledger.execute({ op: 'undo' }).error.code, 'BATCH_NESTING');
  assert.equal(ledger.execute({ op: 'deposit', account: 'a', amount: -5 }).error.code, 'INVALID_INPUT');
  assert.equal(ledger.execute({ op: 'deposit', account: 'a', amount: 5 }).status, 'ok');
  assert.equal(ledger.execute({ op: 'batchEnd' }).status, 'ok');
  assert.equal(ledger.execute({ op: 'teleport', account: 'a', amount: 1 }).error.code, 'INVALID_INPUT');
});

test('undo of a batch whose inverse is no longer legal fails with INVARIANT', () => {
  const ledger = new Ledger();
  ledger.execute({ op: 'batchBegin', id: 'B1' });
  ledger.execute({ op: 'deposit', account: 'a', amount: 100 });
  ledger.execute({ op: 'batchEnd' });
  ledger.execute({ op: 'withdraw', account: 'a', amount: 90 }); // later unit consumes funds
  const u = ledger.execute({ op: 'undo', batch: 'B1' });
  assert.equal(u.status, 'error');
  assert.equal(u.error.code, 'INVARIANT');
  assert.equal(ledger.getState().accounts.a.balance, 10);
});

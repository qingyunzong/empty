'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

test('scale: 50k ops stay correct and fast', () => {
  const N = 50000;
  const engine = new Engine({ budget: { day: 100000000 } });
  const start = Date.now();
  let balance = 0;
  for (let i = 0; i < N; i++) {
    let op;
    if (i % 5 === 4) {
      const amount = (i % 97) + 1;
      op = { op: 'withdraw', account: 'acct', amount: Math.min(amount, balance) };
      balance -= op.amount;
    } else {
      op = { op: 'deposit', account: 'acct', amount: (i % 97) + 1 };
      balance += op.amount;
    }
    const r = engine.apply(op);
    assert.equal(r.status, 'ok', 'op ' + i + ': ' + JSON.stringify(r.error));
  }
  const elapsed = Date.now() - start;
  assert.equal(engine.snapshotState().accounts.acct.balance, balance);
  assert.equal(engine.stack.length, N);
  assert.ok(elapsed < 10000, '50k ops took ' + elapsed + 'ms');
  console.log('50k ops in ' + elapsed + 'ms');
});

test('scale: large batch (>8 ops) undo uses canonical reverse order', () => {
  const engine = new Engine();
  engine.apply({ op: 'batchBegin', id: 'big' });
  for (let i = 0; i < 50; i++) {
    engine.apply({ op: 'deposit', account: 'a' + i, amount: i + 1 });
  }
  engine.apply({ op: 'batchEnd', id: 'big' });
  const r = engine.apply({ op: 'undo', batch: 'big' });
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  assert.equal(r.undoPlan.steps.length, 50);
  assert.equal(r.undoPlan.steps[0].account, 'a49');
  assert.equal(r.undoPlan.steps[49].account, 'a0');
  assert.deepEqual(engine.snapshotState().accounts, {});
  assert.equal(engine.stack.length, 0);
});

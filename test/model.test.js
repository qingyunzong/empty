import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePool, compilePool, INVALID_MODEL } from '../src/model.js';

const base = {
  accounts: [{ id: 'A0', limit: 100 }],
  tasks: [
    { id: 'T0', account: 'A0', kind: 'freeze', amount: 10 },
    { id: 'T1', account: 'A0', kind: 'debit', amount: 20 },
  ],
};

function expectInvalid(pool, pattern) {
  assert.throws(
    () => validatePool(pool),
    (err) => {
      assert.equal(err.code, INVALID_MODEL);
      assert.match(err.message, pattern);
      return true;
    },
  );
}

test('valid pool passes validation and compiles', () => {
  const model = compilePool(structuredClone(base));
  assert.equal(model.accounts.length, 1);
  assert.equal(model.tasks.length, 2);
});

test('unknown task target is rejected with INVALID_MODEL', () => {
  const pool = structuredClone(base);
  pool.tasks.push({ id: 'T2', account: 'A0', kind: 'unfreeze', target: 'T9' });
  expectInvalid(pool, /unknown task T9/);
});

test('unknown task kind is rejected with INVALID_MODEL', () => {
  const pool = structuredClone(base);
  pool.tasks.push({ id: 'T2', account: 'A0', kind: 'explode', amount: 1 });
  expectInvalid(pool, /unknown kind/);
});

test('unfreeze targeting a debit is rejected', () => {
  const pool = structuredClone(base);
  pool.tasks.push({ id: 'T2', account: 'A0', kind: 'unfreeze', target: 'T1' });
  expectInvalid(pool, /cannot target T1/);
});

test('duplicate completion (two cancellers for one target) is rejected', () => {
  const pool = structuredClone(base);
  pool.tasks.push({ id: 'T2', account: 'A0', kind: 'unfreeze', target: 'T0' });
  pool.tasks.push({ id: 'T3', account: 'A0', kind: 'unfreeze', target: 'T0' });
  expectInvalid(pool, /duplicate completion/);
});

test('duplicate task id is rejected', () => {
  const pool = structuredClone(base);
  pool.tasks.push({ id: 'T0', account: 'A0', kind: 'debit', amount: 5 });
  expectInvalid(pool, /duplicate task id T0/);
});

test('over-limit amount is rejected with INVALID_MODEL', () => {
  const pool = structuredClone(base);
  pool.tasks[0].amount = 101;
  expectInvalid(pool, /exceeds limit 100/);
});

test('non-positive and non-integer amounts are rejected', () => {
  for (const amount of [0, -5, 1.5, '10']) {
    const pool = structuredClone(base);
    pool.tasks[0].amount = amount;
    expectInvalid(pool, /amount/);
  }
});

test('unknown account is rejected', () => {
  const pool = structuredClone(base);
  pool.tasks[0].account = 'A9';
  expectInvalid(pool, /unknown account A9/);
});

test('non-positive limit is rejected', () => {
  const pool = structuredClone(base);
  pool.accounts[0].limit = 0;
  expectInvalid(pool, /limit must be a positive integer/);
});

test('cross-account cancellation is rejected', () => {
  const pool = structuredClone(base);
  pool.accounts.push({ id: 'A1', limit: 50 });
  pool.tasks.push({ id: 'T2', account: 'A1', kind: 'unfreeze', target: 'T0' });
  expectInvalid(pool, /different account/);
});

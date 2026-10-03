import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePool } from '../src/generate.js';

test('same seed rebuilds the identical pool', () => {
  const a = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  const b = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  assert.deepEqual(a, b);
  assert.deepEqual(a.prng, { seed: 7, index: a.prng.index });
});

test('different seeds produce different pools', () => {
  const a = generatePool({ seed: 1, accounts: 3, tasks: 8 });
  const b = generatePool({ seed: 2, accounts: 3, tasks: 8 });
  assert.notEqual(JSON.stringify(a.tasks), JSON.stringify(b.tasks));
});

test('every task records its sampling index and amounts stay within limits', () => {
  const pool = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  for (const task of pool.tasks) {
    assert.ok(Number.isInteger(task.draw) && task.draw >= 0);
    assert.ok(task.amount >= 1);
    assert.ok(task.amount <= pool.accounts[task.account].limit);
  }
});

test('seed 7 covers freeze/debit competition on a shared account', () => {
  const pool = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  const kinds = new Set(pool.tasks.map((t) => t.kind));
  assert.ok(kinds.has('freeze') && kinds.has('debit'));
  const competitive = pool.accounts.some((account, idx) => {
    const onAccount = pool.tasks.filter((t) => t.account === idx);
    const freezes = onAccount.filter((t) => t.kind === 'freeze');
    const debits = onAccount.filter((t) => t.kind === 'debit');
    return freezes.some((f) => debits.some((d) => f.amount + d.amount > account.limit));
  });
  assert.ok(competitive, 'expected freeze and debit tasks contending for one limit');
});

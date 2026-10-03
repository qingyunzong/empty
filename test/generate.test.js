import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePool } from '../src/generate.js';
import { analyzePool } from '../src/enumerate.js';
import { validatePool } from '../src/model.js';
import { stateHash } from '../src/hash.js';

test('generator is deterministic for a recorded seed', () => {
  const a = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  const b = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  assert.deepEqual(a, b);
  assert.equal(stateHash(a), stateHash(b));
  assert.equal(a.prng.algorithm, 'splitmix64');
  assert.ok(a.prng.draws > 0);
});

test('different seeds produce different pools', () => {
  const a = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  const b = generatePool({ seed: 8, accounts: 3, tasks: 8 });
  assert.notEqual(stateHash(a), stateHash(b));
});

test('every generated pool passes model validation', () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const pool = generatePool({ seed, accounts: 3, tasks: 8 });
    assert.doesNotThrow(() => validatePool(pool));
  }
});

test('seed 7 / 3 accounts / 8 tasks covers freeze-debit contention', () => {
  const pool = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  const kinds = new Set(pool.tasks.map((t) => t.kind));
  // All four task kinds are exercised.
  assert.deepEqual([...kinds].sort(), ['cancelDebit', 'debit', 'freeze', 'unfreeze']);
  // Some account hosts both a freeze and a debit competing for its quota.
  const byAccount = new Map();
  for (const task of pool.tasks) {
    if (!byAccount.has(task.account)) byAccount.set(task.account, new Set());
    byAccount.get(task.account).add(task.kind);
  }
  const contended = [...byAccount.values()].filter((k) => k.has('freeze') && k.has('debit'));
  assert.ok(contended.length > 0, 'expected an account with both freeze and debit tasks');
  // The search actually explores the contention: quota gets overcommitted.
  const result = analyzePool(pool);
  assert.equal(result.verdict, 'VIOLATION');
  assert.ok(result.maxLoad > Math.min(...pool.accounts.map((a) => a.limit)));
  assert.ok(result.legalSchedules > 0n);
});

test('pinned regression values for seed 7 / 3 accounts / 8 tasks', () => {
  const pool = generatePool({ seed: 7, accounts: 3, tasks: 8 });
  const result = analyzePool(pool);
  assert.equal(result.legalSchedules, 223700400n);
  assert.equal(result.statesExplored, 2025);
  assert.deepEqual(result.violation.steps, ['T0.reserve', 'T4.reserve']);
});

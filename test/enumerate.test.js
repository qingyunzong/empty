import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePool } from '../src/enumerate.js';
import { bruteForceAnalyze } from '../src/brute.js';
import { generatePool } from '../src/generate.js';

test('safe pool: all schedules enumerated, certificate count is exact', () => {
  const pool = {
    accounts: [{ id: 'A0', limit: 100 }],
    tasks: [
      { id: 'T0', account: 'A0', kind: 'freeze', amount: 10 },
      { id: 'T1', account: 'A0', kind: 'debit', amount: 20 },
    ],
  };
  const result = analyzePool(pool);
  // 4 steps, 2 order constraints => 4!/2^2 = 6 interleavings, all legal.
  assert.equal(result.legalSchedules, 6n);
  assert.equal(result.verdict, 'SAFE');
  assert.equal(result.violation, null);
});

test('contending pool: lexicographically shortest violation is reported', () => {
  const pool = {
    accounts: [{ id: 'A0', limit: 50 }],
    tasks: [
      { id: 'T0', account: 'A0', kind: 'freeze', amount: 40 },
      { id: 'T1', account: 'A0', kind: 'debit', amount: 30 },
    ],
  };
  const result = analyzePool(pool);
  assert.equal(result.verdict, 'VIOLATION');
  assert.deepEqual(result.violation.steps, ['T0.reserve', 'T1.reserve']);
  assert.equal(result.violation.account, 'A0');
  assert.equal(result.violation.used, 0);
  assert.equal(result.violation.frozen, 70);
  assert.equal(result.violation.limit, 50);
});

test('cancelDebit mutual exclusion: exactly two maximal schedules', () => {
  const pool = {
    accounts: [{ id: 'A0', limit: 100 }],
    tasks: [
      { id: 'T0', account: 'A0', kind: 'debit', amount: 10 },
      { id: 'T1', account: 'A0', kind: 'cancelDebit', target: 'T0' },
    ],
  };
  const result = analyzePool(pool);
  // Either the debit completes (cancelDebit then stuck) or the cancelDebit
  // fires (debit then stuck). No other maximal schedule exists.
  assert.equal(result.legalSchedules, 2n);
  assert.equal(result.verdict, 'SAFE');
});

test('unfreeze restores frozen quota before freeze completes', () => {
  const pool = {
    accounts: [{ id: 'A0', limit: 50 }],
    tasks: [
      { id: 'T0', account: 'A0', kind: 'freeze', amount: 50 },
      { id: 'T1', account: 'A0', kind: 'unfreeze', target: 'T0' },
    ],
  };
  const result = analyzePool(pool);
  // Either the freeze completes first (unfreeze then stuck), or the unfreeze
  // fires (freeze then stuck, unfreeze completes): exactly two schedules.
  assert.equal(result.legalSchedules, 2n);
  assert.equal(result.verdict, 'SAFE');
});

test('independent full-permutation enumerator agrees on <=3 task pools', () => {
  for (let seed = 0; seed < 30; seed += 1) {
    for (const accounts of [1, 2]) {
      for (const tasks of [1, 2, 3]) {
        const pool = generatePool({ seed: seed * 100 + accounts * 10 + tasks, accounts, tasks });
        const main = analyzePool(pool);
        const brute = bruteForceAnalyze(pool);
        assert.equal(
          main.legalSchedules,
          brute.legalSchedules,
          `legal schedule count mismatch for seed=${seed} accounts=${accounts} tasks=${tasks}`,
        );
        assert.equal(main.verdict, brute.verdict);
        if (brute.violation === null) {
          assert.equal(main.violation, null);
        } else {
          assert.deepEqual(main.violation, brute.violation);
        }
      }
    }
  }
});

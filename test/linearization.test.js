'use strict';
// Acceptance 1: 5 accounts x 200 random concurrent ops judged exactly, and the
// judge cross-checked against brute-force enumeration of all linearizations
// for n <= 8.
const test = require('node:test');
const assert = require('node:assert');
const { judge } = require('../src/judge');
const {
  mulberry32,
  randomRecords,
  genConcurrentHistory,
  assertJudgeMatchesBrute,
  assertOutcomeInvariants,
} = require('./helpers');

test('judge agrees with brute-force linearization enumeration for n<=8', () => {
  const rand = mulberry32(20261005);
  for (let iter = 0; iter < 300; iter++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 ops
    const records = randomRecords(rand, n, 'A');
    const cfg = {
      creditLimit: 20 + Math.floor(rand() * 100),
      dailyFreezeCap: 25 + Math.floor(rand() * 125),
    };
    assertJudgeMatchesBrute(records, cfg);
  }
});

test('5 accounts x 200 random concurrent ops: exact, deterministic, invariant-safe', () => {
  const accounts = ['acc1', 'acc2', 'acc3', 'acc4', 'acc5'];
  const records = genConcurrentHistory(mulberry32(17), accounts);
  assert.strictEqual(records.length, 5 * 200);
  const configs = Object.fromEntries(accounts.map((a) => [a, { creditLimit: 3000, dailyFreezeCap: 800 }]));

  const first = judge(records, configs);
  const second = judge(records, configs);
  assert.deepStrictEqual(first, second, 'judge is deterministic');

  const byAccount = new Map(accounts.map((a) => [a, records.filter((r) => r.account === a)]));
  let rejected = 0;
  for (const [name, recs] of byAccount) {
    const res = first.accounts[name];
    assert.ok(res.available >= 0, `${name}: available non-negative`);
    for (const outcome of res.outcomes) {
      assertOutcomeInvariants(recs, configs[name], outcome);
      for (const v of outcome.verdicts) if (v.status === 'rejected') rejected++;
    }
  }
  assert.ok(rejected > 0, 'concurrent random load actually exercises rejections');
});

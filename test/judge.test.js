'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { judgeAccount, toEntries, CODE } = require('../src/judge');

const CFG = { creditLimit: 100, dailyFreezeCap: 1000 };

function run(records, cfg = CFG) {
  return judgeAccount(toEntries(records), cfg);
}

function verdictOf(result, opId) {
  const v = result.outcomes[0].verdicts.find((x) => x.opId === opId);
  assert.ok(v, `verdict for ${opId}`);
  return v;
}

const base = { account: 'A', deps: [] };

test('freeze occupies credit; release frees it (partial allowed)', () => {
  const r = run([
    { ...base, opId: 'f1', type: 'freeze', amount: 60, ts: 1, day: 0 },
    { ...base, opId: 'r1', type: 'release', freezeId: 'f1', amount: 25, ts: 2, day: 0, deps: ['f1'] },
  ]);
  assert.strictEqual(verdictOf(r, 'f1').status, 'accepted');
  assert.strictEqual(verdictOf(r, 'r1').status, 'accepted');
  assert.strictEqual(r.available, 65);
});

test('code=10: release more than frozen', () => {
  const r = run([
    { ...base, opId: 'f1', type: 'freeze', amount: 50, ts: 1, day: 0 },
    { ...base, opId: 'r1', type: 'release', freezeId: 'f1', amount: 60, ts: 2, day: 0, deps: ['f1'] },
  ]);
  assert.strictEqual(verdictOf(r, 'r1').status, 'rejected');
  assert.strictEqual(verdictOf(r, 'r1').code, CODE.RELEASE_EXCEEDS_FROZEN);
  assert.strictEqual(r.available, 50, 'rejected release has no effect');
});

test('code=11: freeze driving available negative', () => {
  const r = run([{ ...base, opId: 'f1', type: 'freeze', amount: 150, ts: 1, day: 0 }]);
  assert.strictEqual(verdictOf(r, 'f1').status, 'rejected');
  assert.strictEqual(verdictOf(r, 'f1').code, CODE.NEGATIVE_AVAILABLE);
  assert.strictEqual(r.available, 100);
});

test('code=12: duplicate opId', () => {
  const r = run([
    { ...base, opId: 'f1', type: 'freeze', amount: 10, ts: 1, day: 0 },
    { ...base, opId: 'f1', type: 'freeze', amount: 20, ts: 2, day: 0 },
  ]);
  const [first, second] = r.outcomes[0].verdicts;
  assert.strictEqual(first.status, 'accepted');
  assert.strictEqual(second.status, 'rejected');
  assert.strictEqual(second.code, CODE.DUPLICATE_OP_ID);
  assert.strictEqual(r.available, 90);
});

test('code=13: daily freeze budget exceeded, no partial effect', () => {
  const cfg = { creditLimit: 1000, dailyFreezeCap: 100 };
  const r = run(
    [
      { ...base, opId: 'f1', type: 'freeze', amount: 80, ts: 1, day: 0 },
      { ...base, opId: 'f2', type: 'freeze', amount: 30, ts: 2, day: 0, deps: ['f1'] },
      { ...base, opId: 'f3', type: 'freeze', amount: 20, ts: 3, day: 0, deps: ['f2'] },
      { ...base, opId: 'f4', type: 'freeze', amount: 30, ts: 4, day: 1, deps: ['f3'] },
    ],
    cfg,
  );
  assert.strictEqual(verdictOf(r, 'f2').code, CODE.DAILY_BUDGET_EXCEEDED);
  assert.strictEqual(verdictOf(r, 'f3').status, 'accepted', 'no partial consumption of the budget');
  assert.strictEqual(verdictOf(r, 'f4').status, 'accepted', 'budget resets on a new day');
  assert.strictEqual(r.available, 1000 - 80 - 20 - 30);
});

test('hold requires unreleased freeze; unhold reverses it', () => {
  const r = run([
    { ...base, opId: 'f1', type: 'freeze', amount: 50, ts: 1, day: 0 },
    { ...base, opId: 'h1', type: 'hold', freezeId: 'f1', amount: 30, ts: 2, day: 0, deps: ['f1'] },
    { ...base, opId: 'h2', type: 'hold', freezeId: 'f1', amount: 25, ts: 3, day: 0, deps: ['h1'] },
    { ...base, opId: 'u1', type: 'unhold', freezeId: 'f1', amount: 10, ts: 4, day: 0, deps: ['h2'] },
    { ...base, opId: 'u2', type: 'unhold', freezeId: 'f1', amount: 25, ts: 5, day: 0, deps: ['u1'] },
  ]);
  assert.strictEqual(verdictOf(r, 'h1').status, 'accepted');
  assert.strictEqual(verdictOf(r, 'h2').code, CODE.INVALID_DEPENDENCY, 'exceeds unreleased amount');
  assert.strictEqual(verdictOf(r, 'u1').status, 'accepted');
  assert.strictEqual(verdictOf(r, 'u2').code, CODE.INVALID_DEPENDENCY, 'exceeds held amount');
  assert.deepStrictEqual(r.outcomes[0].freezes.f1, { amount: 50, released: 0, held: 20 });
});

test('code=14: ops referencing a missing or rejected freeze', () => {
  const r = run([
    { ...base, opId: 'r1', type: 'release', freezeId: 'nope', amount: 5, ts: 1, day: 0 },
    { ...base, opId: 'f1', type: 'freeze', amount: 500, ts: 2, day: 0 },
    { ...base, opId: 'h1', type: 'hold', freezeId: 'f1', amount: 5, ts: 3, day: 0, deps: ['f1'] },
  ]);
  assert.strictEqual(verdictOf(r, 'r1').code, CODE.INVALID_DEPENDENCY);
  assert.strictEqual(verdictOf(r, 'f1').code, CODE.NEGATIVE_AVAILABLE);
  assert.strictEqual(verdictOf(r, 'h1').code, CODE.INVALID_DEPENDENCY, 'hold on a rejected freeze');
});

test('dependency cycle is rejected loudly', () => {
  assert.throws(
    () =>
      run([
        { ...base, opId: 'a', type: 'freeze', amount: 1, ts: 1, day: 0, deps: ['b'] },
        { ...base, opId: 'b', type: 'freeze', amount: 1, ts: 2, day: 0, deps: ['a'] },
      ]),
    /cycle/,
  );
});

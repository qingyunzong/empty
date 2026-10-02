'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { judge } = require('../src/judge');
const { genFleetHistory, FLEET_CONFIG } = require('./helpers');

test('5 accounts x 200 ops random concurrent history: judge is consistent and deterministic', () => {
  const ops = genFleetHistory(17, 5, 200);
  assert.equal(ops.length, 5 * 200 + 8); // 1000 + 5 dup + 3 invalid

  const t0 = Date.now();
  const r1 = judge(ops, FLEET_CONFIG);
  const r2 = judge(ops, FLEET_CONFIG);
  const elapsed = Date.now() - t0;

  // deterministic: identical output across runs
  assert.deepEqual(r1, r2);

  assert.equal(Object.keys(r1.accounts).length, 5);
  const uniquePerAccount = new Map();
  for (const op of ops) {
    if (!uniquePerAccount.has(op.account)) uniquePerAccount.set(op.account, new Set());
    uniquePerAccount.get(op.account).add(op.opId);
  }
  for (const [acc, res] of Object.entries(r1.accounts)) {
    // quota invariants can never be violated by any accepted history
    assert.ok(res.available >= 0, `${acc}: available must never go negative`);
    assert.ok(res.frozenTotal >= 0, `${acc}: frozenTotal >= 0`);
    for (const [day, amt] of Object.entries(res.dailyFrozen)) {
      assert.ok(amt <= res.dailyFreezeCap, `${acc}: daily cap respected on ${day}`);
    }
    for (const [id, f] of Object.entries(res.freezes)) {
      assert.ok(f.remaining >= 0 && f.held >= 0, `${acc}/${id}: non-negative buckets`);
      assert.ok(f.remaining + f.held <= f.amount, `${acc}/${id}: never releases more than frozen`);
    }
    // every first-occurrence op got a verdict; sequence is a linearization
    assert.equal(res.sequence.length + res.cyclic.length, uniquePerAccount.get(acc).size);
    // error codes actually exercised
    const codes = new Set(res.verdicts.map((v) => v.code));
    assert.ok(codes.has(0), `${acc}: some ops accepted`);
    assert.ok(codes.has(13) || codes.has(11), `${acc}: budget/limit rejections exercised`);
  }
  // duplicate opIds and invalid ops were rejected with their codes
  const allVerdicts = Object.values(r1.accounts).flatMap((a) => a.verdicts);
  assert.ok(allVerdicts.some((v) => v.code === 12), 'duplicate opId -> 12 exercised');
  assert.ok(allVerdicts.some((v) => v.code === 15), 'invalid op -> 15 exercised');
  assert.ok(allVerdicts.some((v) => v.code === 10), 'over-release -> 10 exercised');

  console.log(`  5x200 judged in ${elapsed}ms`);
}, { timeout: 120000 });

'use strict';
const assert = require('node:assert');
const { judgeAccount, toEntries } = require('../src/judge');
const { bruteForceAccount } = require('../src/brute');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickType(r) {
  if (r < 0.45) return 'freeze';
  if (r < 0.65) return 'hold';
  if (r < 0.9) return 'release';
  return 'unhold';
}

// Random small history for one account (used for n<=8 differential testing).
function randomRecords(rand, n, account) {
  const records = [];
  const freezeIds = [];
  for (let i = 0; i < n; i++) {
    let type = pickType(rand());
    if (type !== 'freeze' && freezeIds.length === 0) type = 'freeze';
    const opId = rand() < 0.06 && i > 0 ? records[Math.floor(rand() * i)].opId : `${account}-op${i}`;
    const deps = [];
    for (let j = 0; j < i; j++) if (rand() < 0.3) deps.push(records[j].opId);
    const rec = {
      opId,
      account,
      type,
      amount: 1 + Math.floor(rand() * 30),
      ts: i + 1,
      day: Math.floor(rand() * 3),
      deps,
    };
    if (type !== 'freeze') rec.freezeId = freezeIds[Math.floor(rand() * freezeIds.length)];
    if (type === 'freeze') freezeIds.push(opId);
    records.push(rec);
  }
  return records;
}

// 5 accounts x 200 ops of random concurrent history: per account 20 segments,
// each with 2-3 concurrent lanes (customer-service vs batch style) closed by a
// sync op that merges the lanes via happens-before.
function genConcurrentHistory(rand, accountNames) {
  const records = [];
  let ts = 0;
  for (const account of accountNames) {
    const segments = 20;
    const laneOpsTotal = 9; // + 1 sync op = 10 ops per segment => 200 ops
    let prevSync = null;
    for (let s = 0; s < segments; s++) {
      const lanes = 2 + Math.floor(rand() * 2);
      const lens = Array.from({ length: lanes }, () => Math.floor(laneOpsTotal / lanes));
      for (let k = 0; k < laneOpsTotal % lanes; k++) lens[k] += 1;
      const tips = [];
      const freezeIds = records.filter((r) => r.account === account && r.type === 'freeze').map((r) => r.opId);
      for (let l = 0; l < lanes; l++) {
        let prev = prevSync;
        for (let k = 0; k < lens[l]; k++) {
          ts += 1;
          let type = pickType(rand());
          if (type !== 'freeze' && freezeIds.length === 0) type = 'freeze';
          const opId = `${account}-s${s}-l${l}-o${k}`;
          const deps = [];
          if (prev) deps.push(prev);
          if (tips.length > 0 && rand() < 0.3) deps.push(tips[Math.floor(rand() * tips.length)]);
          const rec = {
            opId,
            account,
            type,
            amount: 5 + Math.floor(rand() * 36),
            ts,
            day: Math.floor(s / 2),
            deps,
          };
          if (type !== 'freeze') rec.freezeId = freezeIds[Math.floor(rand() * freezeIds.length)];
          if (type === 'freeze') freezeIds.push(opId);
          records.push(rec);
          prev = opId;
        }
        if (prev) tips.push(prev);
      }
      ts += 1;
      const syncId = `${account}-s${s}-sync`;
      records.push({
        opId: syncId,
        account,
        type: 'freeze',
        amount: 5,
        ts,
        day: Math.floor(s / 2),
        deps: tips,
      });
      prevSync = syncId;
    }
  }
  return records;
}

function signaturesOf(outcomes) {
  return outcomes.map((o) => o.signature).sort();
}

function assertJudgeMatchesBrute(records, cfg) {
  const entries = toEntries(records);
  const j = judgeAccount(entries, cfg);
  const b = bruteForceAccount(entries, cfg);
  assert.deepStrictEqual(j.score, b.score, 'optimal score must match brute force');
  assert.deepStrictEqual(signaturesOf(j.outcomes), signaturesOf(b.outcomes), 'tied outcome set must match brute force');
  assert.strictEqual(j.available, b.available, 'available credit must match brute force');
  return j;
}

// Replays an outcome's verdicts along its witness linearization and asserts
// all invariants.
function assertOutcomeInvariants(records, cfg, outcome) {
  assert.strictEqual(records.length, outcome.verdicts.length);
  let available = cfg.creditLimit;
  const budgets = new Map();
  const freezes = new Map();
  const seen = new Set();
  for (const i of outcome.order) {
    seen.add(i);
    const rec = records[i];
    const v = outcome.verdicts[i];
    assert.strictEqual(v.opId, rec.opId);
    for (const d of rec.deps || []) {
      const depIdx = records.findIndex((r) => r.opId === d);
      assert.ok(seen.has(depIdx), `happens-before respected (${rec.opId} after ${d})`);
    }
    if (v.status === 'rejected') {
      assert.ok(v.code >= 10 && v.code <= 14, `rejected op ${rec.opId} carries an error code`);
      return;
    }
    if (rec.type === 'freeze') {
      const used = budgets.get(rec.day) || 0;
      assert.ok(used + rec.amount <= cfg.dailyFreezeCap, `daily budget respected (${rec.opId})`);
      assert.ok(rec.amount <= available, `available stays non-negative (${rec.opId})`);
      budgets.set(rec.day, used + rec.amount);
      available -= rec.amount;
      freezes.set(rec.opId, { amount: rec.amount, released: 0, held: 0 });
    } else if (rec.type === 'release') {
      const f = freezes.get(rec.freezeId);
      assert.ok(f, `release targets an accepted freeze (${rec.opId})`);
      assert.ok(rec.amount <= f.amount - f.released, `release within frozen amount (${rec.opId})`);
      f.released += rec.amount;
      available += rec.amount;
    } else if (rec.type === 'hold') {
      const f = freezes.get(rec.freezeId);
      assert.ok(f, `hold targets an accepted freeze (${rec.opId})`);
      assert.ok(rec.amount <= f.amount - f.released - f.held, `hold within unreleased amount (${rec.opId})`);
      f.held += rec.amount;
    } else if (rec.type === 'unhold') {
      const f = freezes.get(rec.freezeId);
      assert.ok(f && rec.amount <= f.held, `unhold within held amount (${rec.opId})`);
      f.held -= rec.amount;
    }
  }
  assert.strictEqual(seen.size, records.length, 'witness order covers every op');
  assert.ok(available >= 0, 'final available is non-negative');
  assert.strictEqual(available, outcome.available, 'reported available matches replay');
}

module.exports = {
  mulberry32,
  randomRecords,
  genConcurrentHistory,
  assertJudgeMatchesBrute,
  assertOutcomeInvariants,
  signaturesOf,
};

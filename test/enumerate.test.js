'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPlan } = require('../lib/plan');
const { mulberry32 } = require('./helpers');

// Independent reference implementation: drops, then sequential moves,
// then per-account net equality and REVERSAL causality.
function referenceApply(entries, plan) {
  const drops = new Set(plan.dropIds || []);
  let res = entries.filter((e) => !drops.has(e.id)).map((e) => ({ ...e }));
  for (const [id, before] of Object.entries(plan.moveBefore || {})) {
    if (id === before) return { ok: false };
    const from = res.findIndex((e) => e.id === id);
    if (from < 0) return { ok: false };
    const [item] = res.splice(from, 1);
    const to = res.findIndex((e) => e.id === before);
    if (to < 0) return { ok: false };
    res.splice(to, 0, item);
  }
  const net = (list) => {
    const m = {};
    for (const e of list) m[e.account] = (m[e.account] || 0) + e.amount;
    return m;
  };
  const a = net(entries);
  const b = net(res);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] || 0) !== (b[k] || 0)) return { ok: false };
  }
  const idx = new Map(res.map((e, i) => [e.id, i]));
  for (const e of res) {
    if (e.type === 'REVERSAL') {
      const r = idx.get(e.refId);
      if (r === undefined || r > idx.get(e.id)) return { ok: false };
    }
  }
  return { ok: true, result: res };
}

function makeDay(n, rng) {
  const accounts = ['A', 'B', 'C'];
  const entries = [];
  for (let i = 0; i < n; i++) {
    const account = accounts[Math.floor(rng() * accounts.length)];
    const amount = Math.floor(rng() * 1000) - 500 || 1;
    entries.push({ id: `e${i}`, account, amount, type: 'NORMAL' });
  }
  // pair reversals so that causality and balanced drops actually occur
  for (const i of [1, 3]) {
    if (i < n) {
      const orig = entries[i - 1];
      entries[i] = {
        id: `e${i}`,
        account: orig.account,
        amount: -orig.amount,
        type: 'REVERSAL',
        refId: orig.id,
      };
    }
  }
  return entries;
}

test('exhaustive drop/move enumeration for n<=6 matches reference net & causality', () => {
  const rng = mulberry32(20261004);
  let accepted = 0;
  let rejected = 0;
  for (let n = 1; n <= 6; n++) {
    const entries = makeDay(n, rng);
    const ids = entries.map((e) => e.id);
    const masks = 1 << n;
    for (let mask = 0; mask < masks; mask++) {
      const dropIds = ids.filter((_, i) => mask & (1 << i));
      const moveOptions = [null];
      for (const id of ids) {
        for (const before of ids) {
          if (id !== before) moveOptions.push([id, before]);
        }
      }
      for (const mv of moveOptions) {
        const plan = { date: '2026-10-04', dropIds };
        if (mv) plan.moveBefore = { [mv[0]]: mv[1] };
        const expected = referenceApply(entries, plan);
        let actual = null;
        let threw = null;
        try {
          actual = applyPlan(entries, plan);
        } catch (e) {
          threw = e;
        }
        if (expected.ok) {
          assert.equal(threw, null, `n=${n} plan=${JSON.stringify(plan)} threw ${threw}`);
          assert.deepEqual(
            actual.map((e) => e.id),
            expected.result.map((e) => e.id),
            `order mismatch n=${n} plan=${JSON.stringify(plan)}`
          );
          assert.deepEqual(
            actual.map((e) => e.amount),
            expected.result.map((e) => e.amount)
          );
          accepted++;
        } else {
          assert.ok(threw, `n=${n} plan=${JSON.stringify(plan)} should be rejected`);
          assert.equal(threw.code, 'E_PLAN_INVALID');
          assert.equal(threw.exitCode, 22);
          rejected++;
        }
      }
    }
  }
  assert.ok(accepted > 0 && rejected > 0, `accepted=${accepted} rejected=${rejected}`);
  console.log(`enumeration: accepted=${accepted} rejected=${rejected}`);
});

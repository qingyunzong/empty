'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const settle = require('../lib/settle');
const { mulberry32, randomInstance } = require('./helpers');

// Independent re-implementation used only to cross-check the library.
function bruteForce(obligations, constraints) {
  const n = obligations.length;
  let best = null;
  const feasible = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const members = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(obligations[i]);
    const groups = new Map();
    for (const o of members) {
      const key = [o.from, o.to].sort().join(' ');
      if (!groups.has(key)) groups.set(key, { net: 0, days: 0, a: key.split(' ')[0] });
      const g = groups.get(key);
      g.net += o.from === g.a ? o.amount : -o.amount;
      g.days = Math.max(g.days, o.days);
    }
    let fee = 0;
    let freeze = 0;
    let amount = 0;
    let days = 0;
    const pays = [];
    for (const [key, g] of groups) {
      if (g.net === 0) continue;
      const [a, b] = key.split(' ');
      const from = g.net > 0 ? a : b;
      const to = g.net > 0 ? b : a;
      pays.push({ from, to, amount: Math.abs(g.net) });
      fee += constraints.fixed_fee + Math.floor((Math.abs(g.net) * constraints.fee_bps) / 10000);
      freeze += Math.floor((Math.abs(g.net) * constraints.freeze_bps) / 10000);
      amount += Math.abs(g.net);
      days = Math.max(days, g.days);
    }
    if (fee > constraints.max_total_fee) continue;
    if (days > constraints.max_days) continue;
    if (freeze > constraints.max_total_freeze) continue;
    if (amount > constraints.max_daily_amount) continue;
    let principal = 0;
    for (const o of members) principal += o.amount;
    pays.sort((x, y) =>
      x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : x.amount - y.amount
    );
    const ids = members.map((o) => o.id).sort();
    const key = pays.map((p) => p.from + '>' + p.to + ':' + p.amount).join('|') + '#' + ids.join(',');
    const cand = { key, principal, fee, freeze, days, amount };
    feasible.push(cand);
    if (
      !best ||
      cand.principal > best.principal ||
      (cand.principal === best.principal &&
        (cand.fee < best.fee ||
          (cand.fee === best.fee &&
            (cand.freeze < best.freeze ||
              (cand.freeze === best.freeze && cand.days < best.days)))))
    ) {
      best = cand;
    }
  }
  if (!best) return { feasible };
  const tiedKeys = feasible
    .filter(
      (c) =>
        c.principal === best.principal &&
        c.fee === best.fee &&
        c.freeze === best.freeze &&
        c.days === best.days
    )
    .map((c) => c.key)
    .sort();
  tiedKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { feasible, best, tiedKeys };
}

test('optimize matches independent brute force over all netting sets (n<=14)', () => {
  const cases = 30;
  for (let seed = 1; seed <= cases; seed++) {
    const rng = mulberry32(seed * 7919);
    const n = 2 + (seed % 13); // 2..14
    const { obligations, constraints } = randomInstance(rng, n);
    const expected = bruteForce(obligations, constraints);
    const result = settle.optimize(obligations, constraints);
    if (!expected.best) {
      assert.equal(result.ok, false, `seed ${seed}: expected infeasible`);
      assert.equal(result.code, 70);
      continue;
    }
    assert.equal(result.ok, true, `seed ${seed}: expected feasible`);
    const cert = result.plan.certificate;
    assert.equal(cert.evaluated, 2 ** n - 1, `seed ${seed}: evaluated count`);
    assert.equal(cert.feasibleCount, expected.feasible.length, `seed ${seed}: feasible count`);
    assert.deepEqual(cert.tiedKeys, expected.tiedKeys, `seed ${seed}: tied candidate set`);
    assert.equal(cert.chosenKey, expected.tiedKeys[0], `seed ${seed}: fixed key order selection`);
    assert.equal(
      cert.candidateSetHash,
      settle.sha256hex(settle.canonicalize(expected.tiedKeys)),
      `seed ${seed}: candidate set hash`
    );
    assert.equal(result.plan.metrics.principal, expected.best.principal, `seed ${seed}: principal`);
    assert.equal(result.plan.metrics.fee, expected.best.fee, `seed ${seed}: fee`);
    assert.equal(result.plan.metrics.freeze, expected.best.freeze, `seed ${seed}: freeze`);
    assert.equal(result.plan.metrics.days, expected.best.days, `seed ${seed}: days`);
  }
});

test('netting preserves every party final receivable/payable sign', () => {
  for (let seed = 100; seed < 120; seed++) {
    const rng = mulberry32(seed);
    const n = 2 + (seed % 13);
    const { obligations, constraints } = randomInstance(rng, n);
    constraints.max_total_fee = 1e12;
    constraints.max_days = 99;
    constraints.max_total_freeze = 1e12;
    constraints.max_daily_amount = 1e12;
    const result = settle.optimize(obligations, constraints);
    assert.equal(result.ok, true);
    const members = obligations.filter((o) => result.plan.obligations.includes(o.id));
    const check = settle.checkSignPreservation(members, result.plan.payments);
    assert.equal(check.ok, true, `seed ${seed}: sign preservation`);
  }
});

test('sign preservation check rejects a tampered payment set', () => {
  const members = [
    { id: 'o1', from: 'A', to: 'B', amount: 100, days: 0, status: 'confirmed' },
    { id: 'o2', from: 'B', to: 'A', amount: 40, days: 0, status: 'confirmed' },
  ];
  const tampered = [{ from: 'B', to: 'A', amount: 60, days: 0 }];
  const check = settle.checkSignPreservation(members, tampered);
  assert.equal(check.ok, false);
  assert.equal(check.party, 'A');
});

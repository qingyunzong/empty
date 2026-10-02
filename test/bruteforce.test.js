'use strict';

// Acceptance 1: for n <= 14, an independent brute-force enumeration of all
// netting sets must agree with optimize (optimal cost, full tied set, selection).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../lib/model');
const { makeCase, runCli, statePath, mulberry32 } = require('./helpers');

// Independent reference implementation: recursive subset enumeration,
// plain-object bookkeeping, separately written cost formula.
function referenceBruteForce(obligations, constraints) {
  const totals = {};
  for (const o of obligations) {
    totals[o.from] = (totals[o.from] || 0) - o.amount;
    totals[o.to] = (totals[o.to] || 0) + o.amount;
  }
  const feasible = [];
  const chosen = [];
  function evaluate() {
    const netted = {};
    let grossVolume = 0;
    let grossAmountDays = 0;
    let maxDay = 0;
    for (let i = 0; i < obligations.length; i++) {
      const o = obligations[i];
      if (chosen.includes(i)) {
        netted[o.from] = (netted[o.from] || 0) - o.amount;
        netted[o.to] = (netted[o.to] || 0) + o.amount;
        if (o.day > maxDay) maxDay = o.day;
      } else {
        grossVolume += o.amount;
        grossAmountDays += o.amount * o.day;
      }
    }
    for (const party of Object.keys(netted)) {
      const v = netted[party];
      if (v !== 0 && Math.sign(v) !== Math.sign(totals[party] || 0)) return;
    }
    let nettedVolume = 0;
    for (const party of Object.keys(netted)) {
      if (netted[party] > 0) nettedVolume += netted[party];
    }
    const volume = nettedVolume + grossVolume;
    const freeze = Math.ceil((volume * (10000 + constraints.freezeMarginBps)) / 10000);
    if (freeze > constraints.maxFreeze) return;
    if (volume > constraints.dailyLimit) return;
    const amountDays = grossAmountDays + (chosen.length > 0 ? maxDay * nettedVolume : 0);
    const cost =
      volume * constraints.feeBps +
      freeze * constraints.freezeBps +
      amountDays * constraints.timeBps;
    const ids = chosen.map((i) => obligations[i].id).sort();
    feasible.push({ ids, cost });
  }
  function dfs(i) {
    if (i === obligations.length) {
      evaluate();
      return;
    }
    chosen.push(i);
    dfs(i + 1);
    chosen.pop();
    dfs(i + 1);
  }
  dfs(0);
  if (feasible.length === 0) return { feasibleCount: 0, tiedKeys: [], selectedKey: null, best: null };
  const best = Math.min(...feasible.map((f) => f.cost));
  const tiedKeys = feasible
    .filter((f) => f.cost === best)
    .map((f) => f.ids.join(','))
    .sort();
  return { feasibleCount: feasible.length, tiedKeys, selectedKey: tiedKeys[0], best };
}

function randomInstance(rand) {
  const n = 1 + Math.floor(rand() * 14); // 1..14 obligations
  const parties = ['A', 'B', 'C', 'D', 'E'];
  const obligations = [];
  for (let i = 0; i < n; i++) {
    let from = parties[Math.floor(rand() * parties.length)];
    let to = parties[Math.floor(rand() * parties.length)];
    while (to === from) to = parties[Math.floor(rand() * parties.length)];
    obligations.push({
      id: `o${i}`,
      from,
      to,
      amount: 1 + Math.floor(rand() * 400),
      day: Math.floor(rand() * 6),
      status: 'confirmed',
    });
  }
  const constraints = {
    feeBps: Math.floor(rand() * 40),
    freezeBps: Math.floor(rand() * 20),
    freezeMarginBps: Math.floor(rand() * 200),
    timeBps: Math.floor(rand() * 10),
    maxFreeze: Math.floor(rand() * 3000),
    dailyLimit: Math.floor(rand() * 3000),
  };
  return { obligations, constraints };
}

test('optimize matches independent brute force on 150 random instances (n<=14)', () => {
  const rand = mulberry32(20261002);
  let infeasibleSeen = 0;
  let tiesSeen = 0;
  for (let t = 0; t < 150; t++) {
    const { obligations, constraints } = randomInstance(rand);
    const expected = referenceBruteForce(obligations, constraints);
    const actual = model.optimize(obligations, constraints);
    assert.equal(actual.feasibleCount, expected.feasibleCount, `feasible count, case ${t}`);
    if (expected.feasibleCount === 0) {
      infeasibleSeen++;
      assert.equal(actual.selected, null);
      continue;
    }
    const actualTiedKeys = actual.tied.map((p) => p.ids.join(',')).sort();
    assert.deepEqual(actualTiedKeys, expected.tiedKeys, `tied set, case ${t}`);
    assert.equal(actual.selected.cost, expected.best, `optimal cost, case ${t}`);
    assert.equal(actual.selected.ids.join(','), expected.selectedKey, `selection, case ${t}`);
    if (expected.tiedKeys.length > 1) tiesSeen++;
  }
  assert.ok(infeasibleSeen > 0, 'expected some infeasible random cases');
  assert.ok(tiesSeen > 0, 'expected some tied random cases');
});

test('CLI optimize end-to-end agrees with library on sampled instances', () => {
  const rand = mulberry32(777);
  for (let t = 0; t < 5; t++) {
    const { obligations, constraints } = randomInstance(rand);
    const expected = model.optimize(obligations, constraints);
    const dir = makeCase(obligations, constraints);
    const res = runCli(dir, 'optimize');
    if (expected.feasibleCount === 0) {
      assert.equal(res.status, 70, res.stderr);
      continue;
    }
    assert.equal(res.status, 0, res.stderr);
    const record = JSON.parse(fs.readFileSync(statePath(dir, 'plan.json'), 'utf8'));
    assert.deepEqual(record.selected.ids, expected.selected.ids);
    assert.equal(record.selected.cost, expected.selected.cost);
    assert.equal(record.certificate.candidateSetHash, expected.certificate.candidateSetHash);
    assert.equal(record.tiedCount, expected.tied.length);
  }
});

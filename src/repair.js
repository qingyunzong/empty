'use strict';
// Repair: for erroneously committed (accepted) ops, generate COMPENSATING ops
// appended to the log. History is never rewritten.
//
// Compensation mapping:
//   freeze  -> release of the freeze's remaining (unreleased) amount
//   release -> freeze of the same amount (re-occupies the credit), on a fresh day
//   hold    -> unhold of the same amount
//   unhold  -> hold of the same amount
//
// Exactly-once: a compensation carries `compensates: <opId>`; repair skips any
// op that already has a compensation in the log, so re-running after a crash
// (before, during, or after the append) never writes a duplicate.
const { readHistory, appendRecord } = require('./log');
const { judge } = require('./judge');

function planRepair(records, configs, targetIds) {
  const result = judge(records, configs);
  const maxTs = records.reduce((m, r) => Math.max(m, r.ts), 0);
  const maxDay = records.reduce((m, r) => Math.max(m, r.day), 0);

  const dependedOn = new Set();
  for (const r of records) for (const d of r.deps || []) dependedOn.add(d);
  const tipsByAccount = new Map();
  for (const r of records) {
    if (!dependedOn.has(r.opId)) {
      if (!tipsByAccount.has(r.account)) tipsByAccount.set(r.account, []);
      tipsByAccount.get(r.account).push(r.opId);
    }
  }

  const compensated = new Set(records.filter((r) => r.compensates).map((r) => r.compensates));
  const existingIds = new Set(records.map((r) => r.opId));
  const appends = [];
  const report = [];
  let seq = 0;

  for (const target of targetIds) {
    const rec = records.find((r) => r.opId === target);
    if (!rec) {
      report.push({ op: target, action: 'not-found' });
      continue;
    }
    if (compensated.has(target)) {
      report.push({ op: target, action: 'skipped', reason: 'compensation already exists' });
      continue;
    }
    const acc = result.accounts[rec.account];
    const outcome = acc.outcomes[0];
    const verdict = outcome.verdicts.find((v) => v.opId === target);
    if (!verdict || verdict.status !== 'accepted') {
      report.push({ op: target, action: 'no-op', reason: 'operation was not accepted; nothing to compensate' });
      continue;
    }

    let comp = null;
    if (rec.type === 'freeze') {
      const f = outcome.freezes[target];
      const remaining = f.amount - f.released;
      if (remaining === 0) {
        report.push({ op: target, action: 'no-op', reason: 'freeze already fully released' });
        continue;
      }
      comp = { type: 'release', freezeId: target, amount: remaining, day: rec.day };
    } else if (rec.type === 'release') {
      comp = { type: 'freeze', amount: rec.amount, day: maxDay + 1 };
    } else if (rec.type === 'hold') {
      comp = { type: 'unhold', freezeId: rec.freezeId, amount: rec.amount, day: rec.day };
    } else if (rec.type === 'unhold') {
      comp = { type: 'hold', freezeId: rec.freezeId, amount: rec.amount, day: rec.day };
    }

    let compId = `cmp-${target}`;
    let k = 2;
    while (existingIds.has(compId)) compId = `cmp-${target}-${k++}`;
    existingIds.add(compId);

    const deps = new Set([target, ...(tipsByAccount.get(rec.account) || [])]);
    seq += 1;
    const full = {
      opId: compId,
      account: rec.account,
      type: comp.type,
      amount: comp.amount,
      ts: maxTs + seq,
      day: comp.day,
      deps: [...deps].sort(),
      compensates: target,
    };
    if (comp.freezeId) full.freezeId = comp.freezeId;
    appends.push(full);
    tipsByAccount.set(rec.account, [compId]);
    report.push({ op: target, action: 'compensate', compensation: full });
  }
  return { appends, report };
}

function applyRepair(historyPath, plan) {
  for (const rec of plan.appends) appendRecord(historyPath, rec);
  return plan.report;
}

function repair(historyPath, configs, targetIds) {
  const { records } = readHistory(historyPath);
  const plan = planRepair(records, configs, targetIds);
  applyRepair(historyPath, plan);
  return plan;
}

module.exports = { planRepair, applyRepair, repair };

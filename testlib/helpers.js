'use strict';

// Independent brute-force enumerator. Written separately from lib/ on purpose:
// it re-implements authorization, transitions, invariant checking and canonical
// formatting so tests can cross-check the library item by item.

const fs = require('fs');
const path = require('path');
const { parseSpec } = require('../lib');

function loadSpec(name) {
  const file = path.join(__dirname, '..', 'specs', name);
  return parseSpec(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function independentRoles(spec, subject) {
  const roles = new Set();
  const queue = [...(spec.subjectRoles[subject] || [])];
  while (queue.length > 0) {
    const role = queue.shift();
    if (roles.has(role)) continue;
    roles.add(role);
    for (const parent of spec.roles[role].inherits) queue.push(parent);
  }
  return roles;
}

function independentAllowed(spec, revoked, subject, action, amount) {
  const roles = independentRoles(spec, subject);
  let decision = false;
  for (const rule of spec.rules) {
    if (revoked.has(rule.id)) continue;
    if (rule.action !== action) continue;
    if (!roles.has(rule.role)) continue;
    if (rule.minAmount !== null && amount < rule.minAmount) continue;
    if (rule.maxAmount !== null && amount > rule.maxAmount) continue;
    if (rule.effect === 'deny') return false;
    decision = true;
  }
  return decision;
}

function independentViolates(spec, txs) {
  return txs.some(
    (tx) =>
      tx.approvedBy !== null &&
      tx.approvedBy === tx.submitter &&
      tx.amount > spec.invariant.threshold
  );
}

function independentTransitions(spec, state) {
  const out = [];
  for (const subject of spec.subjects) {
    for (const amount of spec.amounts) {
      if (independentAllowed(spec, state.revoked, subject, 'submit', amount)) {
        out.push({
          action: { op: 'submit', subject, amount },
          next: {
            txs: state.txs.concat([{ submitter: subject, amount, approvedBy: null }]),
            revoked: new Set(state.revoked),
          },
        });
      }
    }
  }
  for (const subject of spec.subjects) {
    for (let tx = 0; tx < state.txs.length; tx++) {
      const target = state.txs[tx];
      if (target.approvedBy !== null) continue;
      if (!independentAllowed(spec, state.revoked, subject, 'approve', target.amount)) continue;
      const txs = state.txs.map((t, i) =>
        i === tx ? { submitter: t.submitter, amount: t.amount, approvedBy: subject } : t
      );
      out.push({
        action: { op: 'approve', subject, tx },
        next: { txs, revoked: new Set(state.revoked) },
      });
    }
  }
  for (const rule of spec.rules) {
    if (!rule.revocable || state.revoked.has(rule.id)) continue;
    const revoked = new Set(state.revoked);
    revoked.add(rule.id);
    out.push({ action: { op: 'revoke', rule: rule.id }, next: { txs: state.txs, revoked } });
  }
  return out;
}

function independentKey(state) {
  const txs = state.txs
    .map((t) => [t.submitter, t.amount, t.approvedBy === null ? '-' : t.approvedBy].join(':'))
    .sort()
    .join(';');
  return `${txs}#${[...state.revoked].sort().join(';')}`;
}

function independentMinDepth(spec) {
  const start = { txs: [], revoked: new Set() };
  const seen = new Set([independentKey(start)]);
  let level = [start];
  for (let depth = 1; depth <= spec.bound; depth++) {
    const next = [];
    for (const state of level) {
      for (const { next: successor } of independentTransitions(spec, state)) {
        const key = independentKey(successor);
        if (seen.has(key)) continue;
        seen.add(key);
        if (independentViolates(spec, successor.txs)) return depth;
        next.push(successor);
      }
    }
    level = next;
  }
  return null;
}

function independentCollect(spec, depth) {
  const found = [];
  const walk = (state, prefix) => {
    for (const { action, next } of independentTransitions(spec, state)) {
      const bad = independentViolates(spec, next.txs);
      if (prefix.length + 1 === depth) {
        if (bad) found.push(prefix.concat([action]));
        continue;
      }
      if (bad) continue;
      walk(next, prefix.concat([action]));
    }
  };
  walk({ txs: [], revoked: new Set() }, []);
  return found;
}

function independentCanon(action) {
  if (action.op === 'submit') {
    return `submit(${action.subject},${String(action.amount).padStart(3, '0')})`;
  }
  if (action.op === 'approve') return `approve(${action.subject},${action.tx})`;
  return `revoke(${action.rule})`;
}

function independentAnalyze(spec) {
  const depth = independentMinDepth(spec);
  if (depth === null) return { status: 'proof' };
  const counterexamples = independentCollect(spec, depth).map((seq) => seq.map(independentCanon));
  counterexamples.sort((a, b) => {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });
  return { status: 'counterexample', length: depth, counterexamples };
}

module.exports = { loadSpec, independentAnalyze, independentCanon };

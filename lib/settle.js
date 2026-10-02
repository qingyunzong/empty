'use strict';

const crypto = require('node:crypto');

const EXIT_INFEASIBLE = 70;
const EXIT_PENDING_AS_UNSATISFIABLE = 71;
const EXIT_ROLLBACK_AFTER_EXECUTION = 72;

const MAX_OBLIGATIONS = 20;

class InputError extends Error {}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function strcmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeObligations(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('obligations document must be a JSON object');
  }
  if (!Array.isArray(raw.obligations) || raw.obligations.length === 0) {
    throw new InputError('obligations document must contain a non-empty "obligations" array');
  }
  const seen = new Set();
  return raw.obligations.map((entry, index) => {
    const where = 'obligations[' + index + ']';
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new InputError(where + ' must be an object');
    }
    const { id, from, to, amount, days = 0, status = 'confirmed' } = entry;
    if (typeof id !== 'string' || id.length === 0) {
      throw new InputError(where + '.id must be a non-empty string');
    }
    if (seen.has(id)) throw new InputError('duplicate obligation id "' + id + '"');
    seen.add(id);
    if (typeof from !== 'string' || from.length === 0) {
      throw new InputError(where + '.from must be a non-empty string');
    }
    if (typeof to !== 'string' || to.length === 0) {
      throw new InputError(where + '.to must be a non-empty string');
    }
    if (from === to) throw new InputError(where + ': from and to must differ');
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new InputError(where + '.amount must be a positive integer (minor units)');
    }
    if (!Number.isInteger(days) || days < 0) {
      throw new InputError(where + '.days must be a non-negative integer');
    }
    if (status !== 'confirmed' && status !== 'pending') {
      throw new InputError(where + '.status must be "confirmed" or "pending"');
    }
    return { id, from, to, amount, days, status };
  });
}

const CONSTRAINT_FIELDS = [
  'fee_bps',
  'fixed_fee',
  'freeze_bps',
  'max_total_fee',
  'max_days',
  'max_total_freeze',
  'max_daily_amount',
];

function normalizeConstraints(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('constraints document must be a JSON object');
  }
  const out = {};
  for (const field of CONSTRAINT_FIELDS) {
    const value = raw[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new InputError('constraints.' + field + ' must be a non-negative integer');
    }
    out[field] = value;
  }
  return out;
}

// Net every unordered party pair algebraically. The net payment direction is
// the sign of the algebraic sum, so each party's net position is preserved
// exactly and no party's receivable/payable sign can flip.
function netPayments(members) {
  const groups = new Map();
  for (const o of members) {
    const [a, b] = o.from < o.to ? [o.from, o.to] : [o.to, o.from];
    const key = a + ' ' + b;
    let g = groups.get(key);
    if (!g) {
      g = { a, b, net: 0, days: 0 };
      groups.set(key, g);
    }
    g.net += o.from === a ? o.amount : -o.amount;
    if (o.days > g.days) g.days = o.days;
  }
  const payments = [];
  for (const g of groups.values()) {
    if (g.net === 0) continue;
    const [from, to] = g.net > 0 ? [g.a, g.b] : [g.b, g.a];
    payments.push({ from, to, amount: Math.abs(g.net), days: g.days });
  }
  payments.sort((x, y) =>
    strcmp(x.from, y.from) || strcmp(x.to, y.to) || x.amount - y.amount
  );
  return payments;
}

function evaluatePayments(payments, constraints) {
  let fee = 0;
  let freeze = 0;
  let amount = 0;
  let days = 0;
  for (const p of payments) {
    fee += constraints.fixed_fee + Math.floor((p.amount * constraints.fee_bps) / 10000);
    freeze += Math.floor((p.amount * constraints.freeze_bps) / 10000);
    amount += p.amount;
    if (p.days > days) days = p.days;
  }
  return { fee, freeze, amount, days };
}

function violationsOf(metrics, constraints) {
  const violations = [];
  if (metrics.fee > constraints.max_total_fee) violations.push('fee');
  if (metrics.days > constraints.max_days) violations.push('days');
  if (metrics.freeze > constraints.max_total_freeze) violations.push('freeze');
  if (metrics.amount > constraints.max_daily_amount) violations.push('daily_amount');
  return violations;
}

function candidateKey(payments, ids) {
  const body = payments.map((p) => p.from + '>' + p.to + ':' + p.amount).join('|');
  return body + '#' + ids.slice().sort(strcmp).join(',');
}

// Objective: maximize settled principal, then minimize fee, freeze, days.
function compareRank(a, b) {
  if (a.principal !== b.principal) return b.principal - a.principal;
  if (a.fee !== b.fee) return a.fee - b.fee;
  if (a.freeze !== b.freeze) return a.freeze - b.freeze;
  return a.days - b.days;
}

function eliminationReason(candidate, best) {
  if (candidate.principal !== best.principal) {
    return 'settled principal ' + candidate.principal + ' < optimal ' + best.principal;
  }
  if (candidate.fee !== best.fee) {
    return 'fee ' + candidate.fee + ' > optimal ' + best.fee + ' at equal principal';
  }
  if (candidate.freeze !== best.freeze) {
    return 'freeze ' + candidate.freeze + ' > optimal ' + best.freeze +
      ' at equal principal and fee';
  }
  if (candidate.days !== best.days) {
    return 'days ' + candidate.days + ' > optimal ' + best.days +
      ' at equal principal, fee and freeze';
  }
  return 'tied optimal; not selected by fixed key order';
}

function optimize(obligations, constraints, opts = {}) {
  const excludePending = !!opts.excludePending;
  const pending = obligations.filter((o) => o.status === 'pending');
  if (pending.length > 0 && !excludePending) {
    return {
      ok: false,
      code: EXIT_PENDING_AS_UNSATISFIABLE,
      error: 'pending obligations must not be treated as unsatisfiable; ' +
        'confirm them or re-run with --exclude-pending',
      pending: pending.map((o) => o.id),
    };
  }
  const active = obligations.filter((o) => o.status === 'confirmed');
  const n = active.length;
  if (n === 0) {
    return { ok: false, code: EXIT_INFEASIBLE, error: 'no confirmed obligations to settle' };
  }
  if (n > MAX_OBLIGATIONS) {
    return {
      ok: false,
      code: 2,
      error: 'too many obligations for exhaustive enumeration (max ' + MAX_OBLIGATIONS + ')',
    };
  }
  const candidates = [];
  const infeasibleByConstraint = { fee: 0, days: 0, freeze: 0, daily_amount: 0 };
  let infeasibleTotal = 0;
  const total = 1 << n;
  for (let mask = 1; mask < total; mask++) {
    const members = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) members.push(active[i]);
    }
    const payments = netPayments(members);
    const metrics = evaluatePayments(payments, constraints);
    let principal = 0;
    for (const o of members) principal += o.amount;
    const violations = violationsOf(metrics, constraints);
    if (violations.length > 0) {
      infeasibleTotal++;
      for (const v of violations) infeasibleByConstraint[v]++;
      continue;
    }
    const ids = members.map((o) => o.id);
    candidates.push({
      ids,
      payments,
      principal,
      fee: metrics.fee,
      freeze: metrics.freeze,
      amount: metrics.amount,
      days: metrics.days,
      key: candidateKey(payments, ids),
    });
  }
  const evaluated = total - 1;
  if (candidates.length === 0) {
    return {
      ok: false,
      code: EXIT_INFEASIBLE,
      error: 'no feasible settlement plan satisfies all constraints',
      evaluated,
      infeasible: { total: infeasibleTotal, byConstraint: infeasibleByConstraint },
    };
  }
  candidates.sort((a, b) => compareRank(a, b) || strcmp(a.key, b.key));
  const best = candidates[0];
  const tied = candidates.filter((c) => compareRank(c, best) === 0);
  const tiedKeys = tied.map((c) => c.key);
  const certificate = {
    algorithm: 'exhaustive-enumeration-v1',
    evaluated,
    feasibleCount: candidates.length,
    tiedCount: tied.length,
    chosenKey: best.key,
    tiedKeys,
    candidateSetHash: sha256hex(canonicalize(tiedKeys)),
  };
  const planId = 'plan-' + sha256hex(best.key).slice(0, 12);
  const eliminated = candidates.slice(1).map((c) => ({
    key: c.key,
    reason: eliminationReason(c, best),
    metrics: {
      principal: c.principal,
      fee: c.fee,
      freeze: c.freeze,
      days: c.days,
      amount: c.amount,
    },
  }));
  const plan = {
    planId,
    version: 1,
    status: 'proposed',
    obligations: best.ids.slice().sort(strcmp),
    payments: best.payments,
    metrics: {
      principal: best.principal,
      fee: best.fee,
      freeze: best.freeze,
      days: best.days,
      amount: best.amount,
    },
    certificate,
  };
  return {
    ok: true,
    plan,
    eliminated,
    evaluated,
    infeasible: { total: infeasibleTotal, byConstraint: infeasibleByConstraint },
    pendingExcluded: excludePending ? pending.map((o) => o.id) : [],
  };
}

function positionsOf(entries) {
  const pos = new Map();
  for (const e of entries) {
    pos.set(e.from, (pos.get(e.from) || 0) - e.amount);
    pos.set(e.to, (pos.get(e.to) || 0) + e.amount);
  }
  return pos;
}

// Netting must not change any party's final receivable/payable sign. Because
// netting is algebraic, positions must be exactly equal before and after.
function checkSignPreservation(members, payments) {
  const before = positionsOf(members);
  const after = positionsOf(payments);
  const parties = new Set([...before.keys(), ...after.keys()]);
  for (const party of parties) {
    const b = before.get(party) || 0;
    const a = after.get(party) || 0;
    if (b !== a || Math.sign(b) !== Math.sign(a)) {
      return { ok: false, party, before: b, after: a };
    }
  }
  return { ok: true };
}

// Re-validate a proposed plan against current obligations and constraints
// before execution. Any violation fails the whole plan; nothing is deducted.
function buildExecution(plan, obligations, constraints) {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.obligations)) {
    throw new InputError('plan document must contain an "obligations" array');
  }
  const byId = new Map(obligations.map((o) => [o.id, o]));
  const members = [];
  for (const id of plan.obligations) {
    const o = byId.get(id);
    if (!o) throw new InputError('plan references unknown obligation "' + id + '"');
    if (o.status === 'pending') {
      return {
        ok: false,
        code: EXIT_PENDING_AS_UNSATISFIABLE,
        error: 'obligation "' + id + '" is pending; it must not be treated as unsatisfiable',
      };
    }
    members.push(o);
  }
  const payments = netPayments(members);
  if (canonicalize(payments) !== canonicalize(plan.payments)) {
    return { ok: false, code: 2, error: 'plan payments do not match the obligations' };
  }
  const metrics = evaluatePayments(payments, constraints);
  const violations = violationsOf(metrics, constraints);
  if (violations.length > 0) {
    return {
      ok: false,
      code: EXIT_INFEASIBLE,
      error: 'plan violates constraints; whole plan rejected, no partial deduction',
      violations,
      metrics,
    };
  }
  const sign = checkSignPreservation(members, payments);
  if (!sign.ok) {
    return {
      ok: false,
      code: 3,
      error: 'netting changed the final receivable/payable sign of party ' + sign.party,
      detail: sign,
    };
  }
  return { ok: true, payments, metrics };
}

function buildReversePlan(plan) {
  const payments = plan.payments.map((p) => ({
    from: p.to,
    to: p.from,
    amount: p.amount,
    days: p.days,
  }));
  return {
    planId: plan.planId + '-reversal',
    version: 1,
    status: 'proposed',
    reverses: plan.planId,
    obligations: plan.obligations.slice(),
    payments,
    metrics: plan.metrics,
    note: 'reverse settlement of executed plan ' + plan.planId,
  };
}

module.exports = {
  EXIT_INFEASIBLE,
  EXIT_PENDING_AS_UNSATISFIABLE,
  EXIT_ROLLBACK_AFTER_EXECUTION,
  MAX_OBLIGATIONS,
  InputError,
  canonicalize,
  sha256hex,
  strcmp,
  normalizeObligations,
  normalizeConstraints,
  netPayments,
  evaluatePayments,
  violationsOf,
  candidateKey,
  compareRank,
  eliminationReason,
  optimize,
  checkSignPreservation,
  buildExecution,
  buildReversePlan,
};

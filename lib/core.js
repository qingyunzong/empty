'use strict';

const { createHash } = require('node:crypto');

const ERR_RULE_CONFLICT = 40; // overlapping rules without declared priority
const ERR_TIME_REVERSED = 41; // time goes backwards / invalid time fields
const ERR_VALIDATION = 2;

class FeeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeeError';
    this.code = code;
  }
}

function assertTime(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new FeeError(ERR_TIME_REVERSED, `invalid time for ${field}: ${String(value)}`);
  }
}

// Fold rules.ndjson events (add / revoke) into effective rule windows.
// Revoke truncates validTo but never deletes history.
function buildRules(events) {
  const rules = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') throw new FeeError(ERR_VALIDATION, 'rule event must be an object');
    if (ev.op === 'add') {
      if (typeof ev.ruleId !== 'string' || ev.ruleId.length === 0) {
        throw new FeeError(ERR_VALIDATION, 'rule add requires ruleId');
      }
      assertTime(ev.validFrom, `rule ${ev.ruleId} validFrom`);
      const validTo = ev.validTo === null || ev.validTo === undefined ? Infinity : ev.validTo;
      if (validTo !== Infinity) assertTime(validTo, `rule ${ev.ruleId} validTo`);
      if (validTo <= ev.validFrom) {
        throw new FeeError(ERR_TIME_REVERSED, `rule ${ev.ruleId}: validTo <= validFrom`);
      }
      if (rules.has(ev.ruleId)) {
        throw new FeeError(ERR_RULE_CONFLICT, `duplicate rule declaration: ${ev.ruleId}`);
      }
      if (!Number.isInteger(ev.rateBps) || ev.rateBps < 0) {
        throw new FeeError(ERR_VALIDATION, `rule ${ev.ruleId}: rateBps must be a non-negative integer`);
      }
      const priority = ev.priority === undefined || ev.priority === null ? null : ev.priority;
      if (priority !== null && !Number.isInteger(priority)) {
        throw new FeeError(ERR_VALIDATION, `rule ${ev.ruleId}: priority must be an integer`);
      }
      rules.set(ev.ruleId, { ruleId: ev.ruleId, validFrom: ev.validFrom, validTo, rateBps: ev.rateBps, priority });
    } else if (ev.op === 'revoke') {
      const rule = rules.get(ev.ruleId);
      if (!rule) throw new FeeError(ERR_VALIDATION, `revoke of unknown rule: ${String(ev.ruleId)}`);
      assertTime(ev.at, `revoke of rule ${ev.ruleId}`);
      // Clamp: revoking at/before validFrom yields an empty window, history kept.
      rule.validTo = Math.min(rule.validTo, Math.max(ev.at, rule.validFrom));
    } else {
      throw new FeeError(ERR_VALIDATION, `unknown rule op: ${String(ev.op)}`);
    }
  }
  const list = [...rules.values()];
  checkOverlaps(list);
  return list;
}

// Any pair of rules whose windows overlap must both declare a priority.
function checkOverlaps(rules) {
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      if (a.validFrom < b.validTo && b.validFrom < a.validTo) {
        if (a.priority === null || b.priority === null) {
          throw new FeeError(
            ERR_RULE_CONFLICT,
            `rules ${a.ruleId} and ${b.ruleId} overlap without declared priority`,
          );
        }
      }
    }
  }
}

function bySelectionOrder(a, b) {
  const pa = a.priority === null ? Infinity : a.priority;
  const pb = b.priority === null ? Infinity : b.priority;
  if (pa !== pb) return pa - pb;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

function byRuleId(a, b) {
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

// Select the effective rule at time ts. Returns null when no rule applies.
// All rules tied at the best (lowest) rate are reported; the winner is
// chosen by fixed priority: lower priority value first, then ruleId.
function selectRule(rules, ts) {
  const active = rules.filter((r) => r.validFrom <= ts && ts < r.validTo);
  if (active.length === 0) return null;
  const bestRate = Math.min(...active.map((r) => r.rateBps));
  const tied = active.filter((r) => r.rateBps === bestRate).sort(byRuleId);
  const chosen = [...tied].sort(bySelectionOrder)[0];
  return { chosen, tied };
}

function feeFor(amount, rateBps) {
  return Math.floor((amount * rateBps) / 10000);
}

function validateTx(tx) {
  if (!tx || typeof tx !== 'object') throw new FeeError(ERR_VALIDATION, 'tx must be an object');
  if (typeof tx.txId !== 'string' || tx.txId.length === 0) {
    throw new FeeError(ERR_VALIDATION, 'tx requires txId');
  }
  assertTime(tx.ts, `tx ${tx.txId} ts`);
  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount < 0) {
    throw new FeeError(ERR_VALIDATION, `tx ${tx.txId}: amount must be a non-negative number`);
  }
}

// Compute the ledger entry for one transaction under the given rules.
function computeFee(rules, tx) {
  validateTx(tx);
  const sel = selectRule(rules, tx.ts);
  if (!sel) {
    return { txId: tx.txId, ts: tx.ts, amount: tx.amount, ruleId: null, rateBps: null, fee: 0, tied: [] };
  }
  return {
    txId: tx.txId,
    ts: tx.ts,
    amount: tx.amount,
    ruleId: sel.chosen.ruleId,
    rateBps: sel.chosen.rateBps,
    fee: feeFor(tx.amount, sel.chosen.rateBps),
    tied: sel.tied.map((r) => r.ruleId),
  };
}

// Piecewise-constant effective windows over the rule timeline.
function effectiveWindows(rules) {
  const points = new Set();
  for (const r of rules) {
    points.add(r.validFrom);
    if (r.validTo !== Infinity) points.add(r.validTo);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const windows = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    const active = rules.filter((r) => r.validFrom <= from && r.validTo >= to);
    let chosen = null;
    let tied = [];
    if (active.length > 0) {
      const bestRate = Math.min(...active.map((r) => r.rateBps));
      tied = active.filter((r) => r.rateBps === bestRate).sort(byRuleId);
      chosen = [...tied].sort(bySelectionOrder)[0];
    }
    const win = {
      from,
      to,
      ruleId: chosen ? chosen.ruleId : null,
      rateBps: chosen ? chosen.rateBps : null,
      tied: tied.map((r) => r.ruleId),
    };
    const prev = windows[windows.length - 1];
    if (
      prev &&
      prev.ruleId === win.ruleId &&
      prev.rateBps === win.rateBps &&
      prev.tied.join(',') === win.tied.join(',')
    ) {
      prev.to = win.to;
    } else {
      windows.push(win);
    }
  }
  return windows;
}

function canonicalEntry(e) {
  return [e.txId, e.ts, e.amount, e.rateBps, e.fee, e.ruleId].join('|');
}

function digestEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0));
  return createHash('sha256').update(sorted.map(canonicalEntry).join('\n')).digest('hex');
}

// Replay transactions in [from, to) from scratch under the given rules.
function replay(rules, txs, from, to) {
  const entries = txs.filter((tx) => tx.ts >= from && tx.ts < to).map((tx) => computeFee(rules, tx));
  const totalFee = entries.reduce((sum, e) => sum + e.fee, 0);
  return { from, to, count: entries.length, totalFee, hash: digestEntries(entries), entries };
}

module.exports = {
  ERR_RULE_CONFLICT,
  ERR_TIME_REVERSED,
  ERR_VALIDATION,
  FeeError,
  buildRules,
  checkOverlaps,
  selectRule,
  feeFor,
  computeFee,
  effectiveWindows,
  canonicalEntry,
  digestEntries,
  replay,
  bySelectionOrder,
};

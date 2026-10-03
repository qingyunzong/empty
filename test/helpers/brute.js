'use strict';

// Independent naive reference model: tracks frozen credit as a per-unit bitmap
// and recomputes everything from scratch after every op. Used to
// cross-check the interval-based Account implementation.

function isInt(v) {
  return Number.isSafeInteger(v);
}

function rangeOf(op) {
  let start = op.start;
  let end = op.end;
  if ((start === undefined || end === undefined) && op.amount && typeof op.amount === 'object') {
    start = op.amount.start;
    end = op.amount.end;
  }
  return [start, end];
}

function bitsToIntervals(bits) {
  const intervals = [];
  let i = 0;
  while (i < bits.length) {
    if (!bits[i]) { i += 1; continue; }
    let j = i;
    while (j < bits.length && bits[j]) j += 1;
    intervals.push([i, j]);
    i = j;
  }
  return intervals;
}

function runBrute(config, ops) {
  const total = config.totalLimit;
  const categoryLimits = config.categoryLimits || {};
  const bits = new Array(total).fill(false);
  let debitedTotal = 0;
  const debitedByScope = {};
  const seen = new Set();

  const sorted = ops
    .map((op, index) => ({ op, index }))
    .sort((a, b) =>
      (a.op.ts - b.op.ts) ||
      (a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : a.index - b.index))
    .map((entry) => entry.op);

  const steps = [];
  for (const op of sorted) {
    let ok = true;
    let reason = null;
    if (seen.has(op.id)) {
      ok = false;
      reason = 'E_DUP';
    } else {
      seen.add(op.id);
      if (op.op === 'freeze' || op.op === 'unfreeze') {
        const [start, end] = rangeOf(op);
        if (!isInt(start) || !isInt(end) || start < 0 || end > total || start >= end) {
          ok = false;
          reason = 'E_RANGE';
        } else if (op.op === 'freeze') {
          for (let i = start; i < end; i += 1) bits[i] = true;
        } else {
          let hit = false;
          for (let i = start; i < end; i += 1) if (bits[i]) hit = true;
          if (!hit) {
            ok = false;
            reason = 'E_RANGE';
          } else {
            for (let i = start; i < end; i += 1) bits[i] = false;
          }
        }
      } else if (op.op === 'debit') {
        const amount = op.amount;
        const scope = op.scope === undefined ? 'default' : op.scope;
        let frozenTotal = 0;
        for (let i = 0; i < total; i += 1) if (bits[i]) frozenTotal += 1;
        if (!isInt(amount) || amount <= 0 || typeof scope !== 'string' || scope.length === 0) {
          ok = false;
          reason = 'E_RANGE';
        } else if (amount > total - frozenTotal - debitedTotal) {
          if (amount <= total - debitedTotal) reason = 'E_RANGE';
          else reason = 'E_LIMIT';
          ok = false;
        } else if (categoryLimits[scope] !== undefined &&
                   amount > categoryLimits[scope] - (debitedByScope[scope] || 0)) {
          ok = false;
          reason = 'E_LIMIT';
        } else {
          debitedTotal += amount;
          debitedByScope[scope] = (debitedByScope[scope] || 0) + amount;
        }
      } else {
        ok = false;
        reason = 'E_RANGE';
      }
    }
    let frozenTotal = 0;
    for (let i = 0; i < total; i += 1) if (bits[i]) frozenTotal += 1;
    steps.push({
      id: op.id,
      ok,
      reason,
      available: total - frozenTotal - debitedTotal,
      frozen: bitsToIntervals(bits),
      debitedTotal,
      debitedByScope: { ...debitedByScope },
    });
  }
  return steps;
}

module.exports = { runBrute };

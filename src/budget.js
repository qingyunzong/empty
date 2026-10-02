'use strict';

const { ReconError, ERR_BUDGET } = require('./errors');

const keyOf = (customerId, date) => `${customerId}|${date}`;

function getNet(state, customerId, date) {
  return state.budgets[keyOf(customerId, date)] || 0;
}

function getLimit(state, customerId, date) {
  const v = state.limits[keyOf(customerId, date)];
  return v === undefined ? Infinity : v;
}

function setLimit(state, customerId, date, limitCents) {
  state.limits[keyOf(customerId, date)] = limitCents;
}

// Aggregate deltas per customer/day and verify every one stays within limit.
// Throws code=22 before mutating anything: the whole batch fails, no partial deduction.
function checkBudget(state, deltas) {
  const agg = new Map();
  for (const d of deltas) {
    const k = keyOf(d.customerId, d.date);
    agg.set(k, (agg.get(k) || 0) + d.delta);
  }
  for (const [k, delta] of agg) {
    const sep = k.lastIndexOf('|');
    const customerId = k.slice(0, sep);
    const date = k.slice(sep + 1);
    const next = getNet(state, customerId, date) + delta;
    const limit = getLimit(state, customerId, date);
    if (Math.abs(next) > limit) {
      throw new ReconError(ERR_BUDGET, 'budget exceeded: whole batch rejected, no partial deduction', {
        customerId, date, currentNet: getNet(state, customerId, date), delta, next, limit,
      });
    }
  }
}

function applyBudget(state, deltas) {
  for (const d of deltas) {
    const k = keyOf(d.customerId, d.date);
    state.budgets[k] = (state.budgets[k] || 0) + d.delta;
  }
}

module.exports = { keyOf, getNet, getLimit, setLimit, checkBudget, applyBudget };

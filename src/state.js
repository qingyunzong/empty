'use strict';
const { createHash } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashValue(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function coreOf(state) {
  return {
    balances: state.balances,
    frozen: state.frozen,
    holds: state.holds,
    frozenAccounts: state.frozenAccounts,
  };
}

function cloneState(state) {
  const holds = {};
  for (const [id, hold] of Object.entries(state.holds)) holds[id] = { ...hold };
  return {
    balances: { ...state.balances },
    frozen: { ...state.frozen },
    holds,
    frozenAccounts: [...state.frozenAccounts],
    rejected: [...state.rejected],
  };
}

function checkInvariants(state, initialTotal) {
  const violations = [];
  let total = 0;
  for (const account of Object.keys(state.balances)) {
    const balance = state.balances[account];
    const frozen = state.frozen[account] || 0;
    total += balance;
    if (frozen < 0) {
      violations.push({ type: 'NEGATIVE_FROZEN', account, frozen });
    }
    if (frozen > balance) {
      violations.push({ type: 'HOLD_EXCEEDS_BALANCE', account, frozen, balance });
    }
  }
  if (total !== initialTotal) {
    violations.push({ type: 'CONSERVATION', expected: initialTotal, actual: total });
  }
  return violations;
}

module.exports = { canonical, hashValue, coreOf, cloneState, checkInvariants };

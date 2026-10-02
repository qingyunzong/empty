'use strict';
const { createHash } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stateHash(state) {
  return sha256Hex(canonical(normalizeState(state)));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Returns a deep copy with every account's holds sorted by hid, so that
// semantically equal states hash identically regardless of hold order.
function normalizeState(state) {
  const copy = deepClone(state);
  if (copy && typeof copy === 'object' && copy.accounts && typeof copy.accounts === 'object') {
    for (const acc of Object.values(copy.accounts)) {
      if (acc && Array.isArray(acc.holds)) {
        acc.holds.sort((x, y) => (x.hid < y.hid ? -1 : x.hid > y.hid ? 1 : 0));
      }
    }
  }
  return copy;
}

function holdsSum(account) {
  return account.holds.reduce((sum, h) => sum + h.amount, 0);
}

function available(account) {
  return account.limit - account.used - holdsSum(account);
}

// Returns null when valid, otherwise an error message.
function validateState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return 'state must be an object';
  }
  if (state.accounts === null || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) {
    return 'state.accounts must be an object';
  }
  for (const [id, acc] of Object.entries(state.accounts)) {
    if (acc === null || typeof acc !== 'object' || Array.isArray(acc)) {
      return `account ${id}: must be an object`;
    }
    if (typeof acc.limit !== 'number' || !Number.isFinite(acc.limit) || acc.limit < 0) {
      return `account ${id}: limit must be a non-negative number`;
    }
    if (typeof acc.used !== 'number' || !Number.isFinite(acc.used) || acc.used < 0) {
      return `account ${id}: used must be a non-negative number`;
    }
    if (!Array.isArray(acc.holds)) {
      return `account ${id}: holds must be an array`;
    }
    const seen = new Set();
    for (const hold of acc.holds) {
      if (hold === null || typeof hold !== 'object' || Array.isArray(hold)) {
        return `account ${id}: hold must be an object`;
      }
      if (typeof hold.hid !== 'string' || hold.hid.length === 0) {
        return `account ${id}: hold.hid must be a non-empty string`;
      }
      if (seen.has(hold.hid)) {
        return `account ${id}: duplicate hid ${hold.hid}`;
      }
      seen.add(hold.hid);
      if (typeof hold.amount !== 'number' || !Number.isFinite(hold.amount) || hold.amount <= 0) {
        return `account ${id}: hold ${hold.hid} amount must be > 0`;
      }
      if (typeof hold.tag !== 'string') {
        return `account ${id}: hold ${hold.hid} tag must be a string`;
      }
    }
    if (acc.limit < acc.used + holdsSum(acc)) {
      return `account ${id}: limit < used + holds (available would be negative)`;
    }
  }
  return null;
}

module.exports = { canonical, sha256Hex, stateHash, normalizeState, deepClone, holdsSum, available, validateState };

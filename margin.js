'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function createState() {
  return { events: {}, positions: {} };
}

function ensurePosition(state, symbol) {
  if (!state.positions[symbol]) {
    state.positions[symbol] = { available: 0, frozen: {}, tombstones: {} };
  }
  return state.positions[symbol];
}

function isPositiveAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isNonEmptyString(s) {
  return typeof s === 'string' && s.length > 0;
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false;
  if (!isNonEmptyString(event.id)) return false;
  if (event.type === 'credit' || event.type === 'freeze') {
    return isNonEmptyString(event.symbol) && isPositiveAmount(event.amount)
      && (event.type === 'credit' || isNonEmptyString(event.freezeId));
  }
  if (event.type === 'release') {
    return isNonEmptyString(event.freezeId) && isPositiveAmount(event.amount);
  }
  return false;
}

function findFreeze(state, freezeId) {
  for (const symbol of Object.keys(state.positions)) {
    const pos = state.positions[symbol];
    if (Object.prototype.hasOwnProperty.call(pos.frozen, freezeId)) {
      return { symbol, entry: pos.frozen[freezeId], tombstoned: false };
    }
    if (Object.prototype.hasOwnProperty.call(pos.tombstones, freezeId)) {
      return { symbol, entry: pos.tombstones[freezeId], tombstoned: true };
    }
  }
  return null;
}

function applyEvent(state, event) {
  if (!validateEvent(event)) return { ok: false, error: 'invalid-event' };

  const existing = state.events[event.id];
  if (existing !== undefined) {
    if (canonical(existing) === canonical(event)) {
      return { ok: true, duplicate: true };
    }
    return { ok: false, error: 'event-conflict' };
  }

  if (event.type === 'credit') {
    const pos = ensurePosition(state, event.symbol);
    pos.available += event.amount;
  } else if (event.type === 'freeze') {
    const pos = ensurePosition(state, event.symbol);
    if (event.amount > pos.available) return { ok: false, error: 'insufficient-margin' };
    pos.available -= event.amount;
    const entry = pos.frozen[event.freezeId];
    if (entry) {
      entry.amount += event.amount;
    } else {
      pos.frozen[event.freezeId] = { freezeId: event.freezeId, symbol: event.symbol, amount: event.amount, released: 0 };
    }
  } else if (event.type === 'release') {
    const found = findFreeze(state, event.freezeId);
    if (!found) return { ok: false, error: 'unknown-freeze' };
    const { symbol, entry, tombstoned } = found;
    if (entry.released + event.amount > entry.amount) return { ok: false, error: 'over-release' };
    entry.released += event.amount;
    const pos = ensurePosition(state, symbol);
    pos.available += event.amount;
    if (!tombstoned && entry.released === entry.amount) {
      delete pos.frozen[event.freezeId];
      pos.tombstones[event.freezeId] = entry;
    }
  }

  state.events[event.id] = event;
  return { ok: true, duplicate: false };
}

function mergeStates(state, other) {
  for (const id of Object.keys(other.events)) {
    const existing = state.events[id];
    if (existing !== undefined && canonical(existing) !== canonical(other.events[id])) {
      return { ok: false, error: 'event-conflict' };
    }
  }
  const incoming = Object.values(other.events)
    .filter((e) => state.events[e.id] === undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const event of incoming) {
    const result = applyEvent(state, event);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function readPosition(state, symbol) {
  const pos = state.positions[symbol];
  if (!pos) return { symbol, available: 0, frozen: [], tombstones: [] };
  const frozen = Object.values(pos.frozen)
    .map((e) => ({ freezeId: e.freezeId, symbol: e.symbol, amount: e.amount, released: e.released, remaining: e.amount - e.released }))
    .sort((a, b) => (a.freezeId < b.freezeId ? -1 : 1));
  const tombstones = Object.values(pos.tombstones)
    .map((e) => ({ freezeId: e.freezeId, symbol: e.symbol, amount: e.amount, released: e.released }))
    .sort((a, b) => (a.freezeId < b.freezeId ? -1 : 1));
  return { symbol, available: pos.available, frozen, tombstones };
}

function releaseHash(state, symbol) {
  const pos = state.positions[symbol];
  const releases = [];
  if (pos) {
    for (const entry of Object.values(pos.frozen)) {
      if (entry.released > 0) releases.push([entry.freezeId, entry.released]);
    }
    for (const entry of Object.values(pos.tombstones)) {
      releases.push([entry.freezeId, entry.released]);
    }
  }
  releases.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return crypto.createHash('sha256').update(canonical(releases)).digest('hex');
}

function getCertificate(state, symbol) {
  const position = readPosition(state, symbol);
  return {
    symbol,
    available: position.available,
    frozen: position.frozen,
    releaseHash: releaseHash(state, symbol),
  };
}

function getCertificates(state) {
  return Object.keys(state.positions).sort().map((symbol) => getCertificate(state, symbol));
}

module.exports = {
  canonical,
  createState,
  applyEvent,
  mergeStates,
  readPosition,
  getCertificate,
  getCertificates,
};

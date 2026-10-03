'use strict';

const crypto = require('node:crypto');

class ReplicaError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReplicaError';
    this.code = code;
  }
}

function createState(limit) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ReplicaError('invalid-limit');
  }
  return { limit, events: [], tombstones: {} };
}

function eventKey(event) {
  return `${event.type}:${event.requestId}`;
}

function findEvent(state, type, requestId) {
  return state.events.find((e) => e.type === type && e.requestId === requestId);
}

function balance(state) {
  let reserved = 0;
  let released = 0;
  for (const event of state.events) {
    if (event.type === 'reserve') reserved += event.amount;
    else if (event.type === 'release') released += event.amount;
  }
  return {
    limit: state.limit,
    reserved,
    released,
    outstanding: reserved - released,
    available: state.limit - reserved + released,
  };
}

function remainingReleasable(state, targetRequestId) {
  const reserve = findEvent(state, 'reserve', targetRequestId);
  if (!reserve) return null;
  let released = 0;
  for (const event of state.events) {
    if (event.type === 'release' && event.target === targetRequestId) {
      released += event.amount;
    }
  }
  return reserve.amount - released;
}

function validateAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ReplicaError('invalid-amount');
  }
}

function applyReserve(state, { requestId, account, amount }, { checkLimit = true } = {}) {
  validateAmount(amount);
  const existing = findEvent(state, 'reserve', requestId);
  if (existing) {
    if (existing.account === account && existing.amount === amount) {
      return { applied: false };
    }
    throw new ReplicaError('payload-conflict');
  }
  if (checkLimit && balance(state).available < amount) {
    throw new ReplicaError('limit-exceeded');
  }
  state.events.push({ type: 'reserve', requestId, account, amount });
  return { applied: true };
}

function applyRelease(state, { requestId, target, amount }) {
  validateAmount(amount);
  const tombstone = state.tombstones[requestId];
  if (tombstone) {
    if (tombstone.target === target && tombstone.amount === amount) {
      return { applied: false };
    }
    throw new ReplicaError('payload-conflict');
  }
  const remaining = remainingReleasable(state, target);
  if (remaining === null) {
    throw new ReplicaError('unknown-reserve');
  }
  if (amount > remaining) {
    throw new ReplicaError('over-release');
  }
  state.events.push({ type: 'release', requestId, target, amount });
  state.tombstones[requestId] = { target, amount };
  return { applied: true };
}

function digest(state) {
  const keys = state.events.map(eventKey).sort();
  const payload = JSON.stringify({ limit: state.limit, keys });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function diff(mine, theirs) {
  const theirKeys = new Set(theirs.events.map(eventKey));
  return {
    digest: digest(mine),
    missing: mine.events.filter((event) => !theirKeys.has(eventKey(event))),
  };
}

function merge(mine, theirs) {
  const incoming = diff(theirs, mine).missing;
  const ordered = [...incoming].sort((a, b) => {
    if (a.type === b.type) return 0;
    return a.type === 'reserve' ? -1 : 1;
  });
  const applied = [];
  for (const event of ordered) {
    if (event.type === 'reserve') {
      const result = applyReserve(mine, event, { checkLimit: false });
      if (result.applied) applied.push(eventKey(event));
    } else if (event.type === 'release') {
      const result = applyRelease(mine, event);
      if (result.applied) applied.push(eventKey(event));
    }
  }
  return applied;
}

module.exports = {
  ReplicaError,
  createState,
  eventKey,
  balance,
  remainingReleasable,
  applyReserve,
  applyRelease,
  digest,
  diff,
  merge,
};

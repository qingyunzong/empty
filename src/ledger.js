'use strict';

const { randomUUID } = require('node:crypto');

class LedgerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function createLedger() {
  return { events: [] };
}

function indexById(ledger) {
  const map = new Map();
  for (const event of ledger.events) map.set(event.id, event);
  return map;
}

// All event ids causally visible from `ids` (inclusive).
function ancestorIds(ledger, ids) {
  const byId = indexById(ledger);
  const seen = new Set();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const event = byId.get(id);
    if (event) stack.push(...event.deps);
  }
  return seen;
}

// True when `ancestorId` happens-before-or-equals `eventId`.
function isAncestor(ledger, ancestorId, eventId) {
  if (ancestorId === eventId) return true;
  return ancestorIds(ledger, [eventId]).has(ancestorId);
}

function areConcurrent(ledger, a, b) {
  return a !== b && !isAncestor(ledger, a, b) && !isAncestor(ledger, b, a);
}

// Causal heads: events that no other event depends on.
function frontier(ledger) {
  const depended = new Set();
  for (const event of ledger.events) {
    for (const dep of event.deps) depended.add(dep);
  }
  return ledger.events.filter((event) => !depended.has(event.id));
}

function compareEvents(a, b) {
  const epochA = a.epoch || 0;
  const epochB = b.epoch || 0;
  if (epochA !== epochB) return epochA - epochB;
  return a.id.localeCompare(b.id);
}

// State of one account as seen from a causal cut (`visibleIds`, null = everything).
function accountState(ledger, name, visibleIds = null) {
  const visible = (event) => visibleIds === null || visibleIds.has(event.id);
  const adds = ledger.events.filter(
    (e) => e.type === 'add-account' && e.account === name && visible(e)
  );
  const removes = ledger.events.filter(
    (e) => e.type === 'remove-account' && e.account === name && visible(e)
  );
  const lastEpoch = Math.max(
    0,
    ...adds.map((e) => e.epoch || 0),
    ...removes.map((e) => e.epoch || 0)
  );
  if (adds.length === 0) {
    return {
      name,
      status: 'unknown',
      incarnation: null,
      epoch: 0,
      lastEpoch,
      balance: 0,
      tombstone: null,
      addEvent: null,
    };
  }
  // Current incarnation: an add not causally dominated by any other add.
  const maximalAdds = adds.filter(
    (a) => !adds.some((b) => a.id !== b.id && isAncestor(ledger, a.id, b.id))
  );
  const sortedAdds = [...maximalAdds].sort(compareEvents);
  const addEvent = sortedAdds[sortedAdds.length - 1];
  // Tombstone of this incarnation: minimal remove that observes the add.
  const candidateRemoves = removes.filter((r) => isAncestor(ledger, addEvent.id, r.id));
  const minimalRemoves = candidateRemoves.filter(
    (r) => !candidateRemoves.some((o) => o.id !== r.id && isAncestor(ledger, o.id, r.id))
  );
  const tombstone = minimalRemoves.length > 0 ? [...minimalRemoves].sort(compareEvents)[0] : null;
  // Balance of this incarnation: money events that observe the add and are
  // not causally after the tombstone. Pre-tombstone history of older
  // incarnations never leaks into a re-added account.
  let balance = 0;
  for (const event of ledger.events) {
    if (!visible(event)) continue;
    if (event.id === addEvent.id) continue;
    if (!isAncestor(ledger, addEvent.id, event.id)) continue;
    if (tombstone && isAncestor(ledger, tombstone.id, event.id)) continue;
    if (event.type === 'pay' && event.account === name) balance += event.amount;
    if (event.type === 'transfer') {
      if (event.from === name) balance -= event.amount;
      if (event.to === name) balance += event.amount;
    }
  }
  return {
    name,
    status: tombstone ? 'removed' : 'active',
    incarnation: addEvent.incarnation,
    epoch: addEvent.epoch,
    lastEpoch,
    balance,
    tombstone,
    addEvent,
  };
}

// Concurrent remove vs pay/transfer on the same account: neither observes
// the other, so the outcome cannot be decided causally.
function accountConflicts(ledger, name) {
  const removes = ledger.events.filter(
    (e) => e.type === 'remove-account' && e.account === name
  );
  const conflicts = [];
  for (const remove of removes) {
    for (const event of ledger.events) {
      if (event.type !== 'pay' && event.type !== 'transfer') continue;
      const involves =
        event.type === 'pay'
          ? event.account === name
          : event.from === name || event.to === name;
      if (!involves) continue;
      if (areConcurrent(ledger, remove.id, event.id)) {
        conflicts.push({
          type: event.type === 'pay' ? 'remove-pay' : 'remove-transfer',
          account: name,
          remove: remove.id,
          event: event.id,
          epoch: remove.epoch,
        });
      }
    }
  }
  return conflicts;
}

function allConflicts(ledger) {
  const names = new Set();
  for (const event of ledger.events) {
    if (event.account) names.add(event.account);
    if (event.from) names.add(event.from);
    if (event.to) names.add(event.to);
  }
  const seen = new Set();
  const result = [];
  for (const name of names) {
    for (const conflict of accountConflicts(ledger, name)) {
      const key = `${conflict.remove}:${conflict.event}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(conflict);
    }
  }
  return result;
}

// All events touching an account (any incarnation), in causal order.
function accountHistory(ledger, name) {
  const events = ledger.events.filter(
    (e) => e.account === name || e.from === name || e.to === name
  );
  const depth = new Map();
  for (const event of events) {
    depth.set(event.id, ancestorIds(ledger, [event.id]).size);
  }
  return events.sort(
    (a, b) => depth.get(a.id) - depth.get(b.id) || a.id.localeCompare(b.id)
  );
}

function requireName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new LedgerError('invalid-name');
}

function requireAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError('invalid-amount');
  }
}

// Append a new causal event. Deps = current frontier, so the event observes
// everything already known and validation sees the full causal past.
function appendEvent(ledger, fields) {
  const deps = frontier(ledger).map((e) => e.id);
  const event = { id: `evt-${randomUUID()}`, deps, ...fields };
  switch (event.type) {
    case 'add-account': {
      requireName(event.account);
      const state = accountState(ledger, event.account);
      if (state.status === 'active') throw new LedgerError('account-exists');
      event.epoch = state.lastEpoch + 1;
      event.incarnation = `inc-${randomUUID()}`;
      break;
    }
    case 'remove-account': {
      requireName(event.account);
      const state = accountState(ledger, event.account);
      if (state.status === 'unknown') throw new LedgerError('unknown-account');
      if (state.status === 'removed') throw new LedgerError('account-removed');
      if (state.balance !== 0) throw new LedgerError('balance-not-zero');
      event.epoch = state.epoch;
      event.incarnation = state.incarnation;
      break;
    }
    case 'pay': {
      requireName(event.account);
      requireAmount(event.amount);
      const state = accountState(ledger, event.account);
      if (state.status === 'unknown') throw new LedgerError('unknown-account');
      if (state.status === 'removed') throw new LedgerError('account-removed');
      event.incarnation = state.incarnation;
      break;
    }
    case 'transfer': {
      requireName(event.from);
      requireName(event.to);
      if (event.from === event.to) throw new LedgerError('same-account');
      requireAmount(event.amount);
      for (const name of [event.from, event.to]) {
        const state = accountState(ledger, name);
        if (state.status === 'unknown') throw new LedgerError('unknown-account');
        if (state.status === 'removed') throw new LedgerError('account-removed');
      }
      break;
    }
    default:
      throw new LedgerError('unknown-event-type');
  }
  ledger.events.push(event);
  return event;
}

const EVENT_TYPES = new Set(['add-account', 'remove-account', 'transfer', 'pay']);

function validateEventShape(event) {
  if (!event || typeof event !== 'object') throw new LedgerError('invalid-event');
  if (typeof event.id !== 'string' || event.id.length === 0) throw new LedgerError('invalid-event');
  if (!EVENT_TYPES.has(event.type)) throw new LedgerError('invalid-event');
  if (!Array.isArray(event.deps)) throw new LedgerError('invalid-event');
}

// Union of events by id. Returns the number of newly merged events.
function mergeLedgers(target, source) {
  if (!source || !Array.isArray(source.events)) throw new LedgerError('invalid-ledger');
  const known = new Set(target.events.map((e) => e.id));
  let merged = 0;
  for (const event of source.events) {
    validateEventShape(event);
    if (known.has(event.id)) continue;
    known.add(event.id);
    target.events.push(event);
    merged += 1;
  }
  return merged;
}

module.exports = {
  LedgerError,
  createLedger,
  ancestorIds,
  isAncestor,
  areConcurrent,
  frontier,
  accountState,
  accountConflicts,
  allConflicts,
  accountHistory,
  appendEvent,
  mergeLedgers,
  validateEventShape,
};

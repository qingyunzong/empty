import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export function createLedger(replica) {
  return {
    replica: replica ?? `r-${randomUUID().slice(0, 8)}`,
    seq: 0,
    events: [],
  };
}

export function happensBefore(a, b) {
  if (a.id === b.id) return false;
  let strict = false;
  const keys = new Set([...Object.keys(a.clock), ...Object.keys(b.clock)]);
  for (const key of keys) {
    const x = a.clock[key] ?? 0;
    const y = b.clock[key] ?? 0;
    if (x > y) return false;
    if (x < y) strict = true;
  }
  return strict;
}

export function areConcurrent(a, b) {
  return a.id !== b.id && !happensBefore(a, b) && !happensBefore(b, a);
}

export function sortCausal(events) {
  const remaining = [...events];
  const sorted = [];
  while (remaining.length > 0) {
    const minimals = remaining.filter(
      (event) => !remaining.some((other) => happensBefore(other, event)),
    );
    minimals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const next = minimals[0];
    sorted.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return sorted;
}

function appendEvent(ledger, fields) {
  const clock = {};
  for (const event of ledger.events) {
    for (const [key, value] of Object.entries(event.clock)) {
      clock[key] = Math.max(clock[key] ?? 0, value);
    }
  }
  ledger.seq = Math.max(ledger.seq, clock[ledger.replica] ?? 0) + 1;
  clock[ledger.replica] = ledger.seq;
  const event = { id: `${ledger.replica}:${ledger.seq}`, clock, ...fields };
  ledger.events.push(event);
  return event;
}

function addsFor(ledger, name) {
  return ledger.events.filter((e) => e.type === 'add-account' && e.name === name);
}

function tombstonesFor(ledger, name) {
  return ledger.events.filter((e) => e.type === 'remove-account' && e.name === name);
}

function latestAdd(ledger, name) {
  const adds = addsFor(ledger, name);
  return adds.find((a) => !adds.some((b) => happensBefore(a, b))) ?? null;
}

function tombstoneForIncarnation(ledger, addEvent, name) {
  const tombs = tombstonesFor(ledger, name).filter((t) => happensBefore(addEvent, t));
  return tombs.find((t) => !tombs.some((o) => happensBefore(o, t))) ?? null;
}

function affectsBalance(event, name) {
  if (event.type === 'pay') return event.name === name;
  if (event.type === 'transfer') return event.from === name || event.to === name;
  return false;
}

function signedAmount(event, name) {
  if (event.type === 'pay') return event.amount;
  if (event.type === 'transfer') {
    let total = 0;
    if (event.to === name) total += event.amount;
    if (event.from === name) total -= event.amount;
    return total;
  }
  return 0;
}

export function accountState(ledger, name) {
  const history = sortCausal(
    ledger.events.filter(
      (e) =>
        ((e.type === 'add-account' || e.type === 'remove-account') && e.name === name) ||
        affectsBalance(e, name),
    ),
  );
  const add = latestAdd(ledger, name);
  if (!add) {
    return { name, status: 'unknown', incarnation: null, epoch: 0, balance: 0, history };
  }
  const tomb = tombstoneForIncarnation(ledger, add, name);
  const inScope = ledger.events.filter(
    (e) =>
      affectsBalance(e, name) &&
      happensBefore(add, e) &&
      (!tomb || happensBefore(e, tomb)),
  );
  const balance = inScope.reduce((sum, e) => sum + signedAmount(e, name), 0);
  return {
    name,
    status: tomb ? 'removed' : 'active',
    incarnation: add.incarnation,
    epoch: tomb ? tomb.epoch : add.epoch,
    balance,
    history,
  };
}

function requireActive(ledger, name) {
  const state = accountState(ledger, name);
  if (state.status === 'unknown') {
    throw new LedgerError('no-such-account', `unknown account: ${name}`);
  }
  if (state.status === 'removed') {
    throw new LedgerError('account-removed', `account removed: ${name}`);
  }
  return state;
}

function assertAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError('invalid-amount', `invalid amount: ${amount}`);
  }
}

function assertName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new LedgerError('invalid-arguments', 'account name is required');
  }
}

export function addAccount(ledger, name) {
  assertName(name);
  const state = accountState(ledger, name);
  if (state.status === 'active') {
    throw new LedgerError('account-exists', `account already active: ${name}`);
  }
  const epoch = tombstonesFor(ledger, name).length;
  const incarnation = `${name}#${epoch + 1}`;
  return appendEvent(ledger, { type: 'add-account', name, incarnation, epoch });
}

export function removeAccount(ledger, name) {
  assertName(name);
  const state = requireActive(ledger, name);
  if (state.balance !== 0) {
    throw new LedgerError(
      'balance-not-zero',
      `account ${name} has non-zero balance ${state.balance}`,
    );
  }
  return appendEvent(ledger, {
    type: 'remove-account',
    name,
    incarnation: state.incarnation,
    epoch: state.epoch + 1,
  });
}

export function pay(ledger, name, amount) {
  assertName(name);
  assertAmount(amount);
  requireActive(ledger, name);
  return appendEvent(ledger, { type: 'pay', name, amount });
}

export function transfer(ledger, from, to, amount) {
  assertName(from);
  assertName(to);
  assertAmount(amount);
  requireActive(ledger, from);
  requireActive(ledger, to);
  return appendEvent(ledger, { type: 'transfer', from, to, amount });
}

export function findConflicts(ledger) {
  const tombs = ledger.events.filter((e) => e.type === 'remove-account');
  const conflicts = [];
  for (const tomb of tombs) {
    for (const event of ledger.events) {
      if (event.id === tomb.id) continue;
      if (!affectsBalance(event, tomb.name)) continue;
      if (areConcurrent(event, tomb)) {
        conflicts.push({ name: tomb.name, tombstone: tomb.id, event: event.id });
      }
    }
  }
  return conflicts;
}

export function mergeLedgers(target, source) {
  const known = new Set(target.events.map((e) => e.id));
  const merged = { replica: target.replica, seq: target.seq, events: [...target.events] };
  let added = 0;
  for (const event of source.events) {
    if (!known.has(event.id)) {
      merged.events.push(event);
      added += 1;
    }
  }
  const conflicts = findConflicts(merged);
  if (conflicts.length > 0) {
    const error = new LedgerError(
      'conflict',
      `concurrent remove and payment for account ${conflicts[0].name}`,
    );
    error.details = conflicts;
    throw error;
  }
  return { ledger: merged, added };
}

export function loadLedger(path) {
  if (!existsSync(path)) return createLedger();
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof data !== 'object' || data === null ||
    typeof data.replica !== 'string' ||
    typeof data.seq !== 'number' ||
    !Array.isArray(data.events)
  ) {
    throw new LedgerError('invalid-ledger', `not a ledger file: ${path}`);
  }
  return data;
}

export function saveLedger(path, ledger) {
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

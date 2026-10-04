import { createHash } from 'node:crypto';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export const STATUS = Object.freeze({
  PENDING: 'pending',
  CANCELLED: 'cancelled',
  SETTLED: 'settled',
});

export function createState() {
  return { entries: {}, settlements: [] };
}

function assertParticipant(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_ENTRY', `${field} must be a non-empty string`);
  }
}

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new LedgerError('INVALID_ENTRY', 'amount must be a positive safe integer (minor units)');
  }
}

function assertEntryId(entryId) {
  if (typeof entryId !== 'string' || entryId.length === 0) {
    throw new LedgerError('INVALID_ENTRY', 'entryId must be a non-empty string');
  }
}

export function applySubmit(state, entry) {
  const { entryId, payer, payee, amount } = entry ?? {};
  assertEntryId(entryId);
  assertParticipant(payer, 'payer');
  assertParticipant(payee, 'payee');
  if (payer === payee) {
    throw new LedgerError('INVALID_ENTRY', 'payer and payee must differ');
  }
  assertAmount(amount);
  const existing = state.entries[entryId];
  if (existing) {
    return { changed: false, duplicate: true, entry: existing };
  }
  const stored = { entryId, payer, payee, amount, status: STATUS.PENDING };
  state.entries[entryId] = stored;
  return { changed: true, duplicate: false, entry: stored };
}

export function applyCancel(state, { entryId }) {
  assertEntryId(entryId);
  const entry = state.entries[entryId];
  if (!entry) {
    throw new LedgerError('ENTRY_NOT_FOUND', `entry ${entryId} does not exist`);
  }
  if (entry.status !== STATUS.PENDING) {
    throw new LedgerError(
      'ENTRY_NOT_PENDING',
      `entry ${entryId} is ${entry.status}; only pending entries can be cancelled`,
    );
  }
  entry.status = STATUS.CANCELLED;
  return { changed: true, entry };
}

export function pendingEntries(state) {
  return Object.values(state.entries).filter((e) => e.status === STATUS.PENDING);
}

export function computeNets(entries) {
  const nets = {};
  for (const entry of entries) {
    nets[entry.payer] = (nets[entry.payer] ?? 0) - entry.amount;
    nets[entry.payee] = (nets[entry.payee] ?? 0) + entry.amount;
  }
  return nets;
}

export function applySettle(state) {
  const pending = pendingEntries(state);
  if (pending.length === 0) {
    return { changed: false, settlement: null };
  }
  const nets = computeNets(pending);
  const entryIds = pending.map((e) => e.entryId).sort();
  for (const entry of pending) {
    entry.status = STATUS.SETTLED;
  }
  const settlement = { seq: state.settlements.length + 1, entryIds, nets };
  state.settlements.push(settlement);
  return { changed: true, settlement };
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`)
    .join(',');
  return `{${body}}`;
}

export function stateHash(state) {
  return createHash('sha256').update(canonicalStringify(state), 'utf8').digest('hex');
}

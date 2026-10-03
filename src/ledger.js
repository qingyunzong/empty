import { hashObject } from './canonical.js';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const CORRECTION_TYPES = new Set(['add', 'reverse', 'adjust']);

export function emptyState() {
  return { batches: new Map() };
}

function ensureBatch(state, batchId) {
  let batch = state.batches.get(batchId);
  if (!batch) {
    batch = {
      batchId,
      version: 0,
      status: 'open',
      entries: [],
      deltas: [],
      compensation: [],
      frozenTotal: 0,
      certificate: null,
      requests: new Map(),
    };
    state.batches.set(batchId, batch);
  }
  return batch;
}

// Pure, order-tolerant fold over the event log. Entry math is commutative
// because corrections are materialized as signed deltas at apply time.
export function applyEvent(state, event) {
  const batch = ensureBatch(state, event.batchId);
  switch (event.type) {
    case 'batch_created':
      batch.entries = event.entries.map((e) => ({ ...e }));
      batch.frozenTotal = event.frozenTotal;
      batch.version = Math.max(batch.version, 1);
      break;
    case 'correction_applied':
      batch.deltas.push(...event.deltas.map((d) => ({ ...d })));
      batch.version = Math.max(batch.version, event.version);
      break;
    case 'confirmed':
      batch.certificate = event.certificate;
      if (batch.status === 'open') batch.status = 'confirmed';
      break;
    case 'cancelled':
      batch.status = 'cancelled';
      if (event.compensation) batch.compensation = event.compensation.map((c) => ({ ...c }));
      break;
    default:
      throw new LedgerError('UNKNOWN_EVENT', `unknown event type: ${event.type}`);
  }
  if (event.requestId && event.result !== undefined) {
    batch.requests.set(event.requestId, event.result);
  }
  return state;
}

export function deriveState(events) {
  const state = emptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

function getBatch(state, batchId) {
  const batch = state.batches.get(batchId);
  if (!batch || batch.version === 0) {
    throw new LedgerError('BATCH_NOT_FOUND', `batch not found: ${batchId}`);
  }
  return batch;
}

function cachedResult(batch, requestId) {
  if (typeof requestId === 'string' && batch.requests.has(requestId)) {
    return batch.requests.get(requestId);
  }
  return null;
}

function requireRequestId(cmd) {
  if (typeof cmd.requestId !== 'string' || cmd.requestId.length === 0) {
    throw new LedgerError('INVALID_INPUT', 'requestId is required and must be a non-empty string');
  }
}

function validateEntry(entry, index) {
  const where = `entries[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new LedgerError('INVALID_INPUT', `${where} must be an object`);
  }
  if (typeof entry.entryId !== 'string' || entry.entryId.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${where}.entryId must be a non-empty string`);
  }
  if (typeof entry.account !== 'string' || entry.account.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${where}.account must be a non-empty string`);
  }
  if (!Number.isSafeInteger(entry.amount) || entry.amount === 0) {
    throw new LedgerError('INVALID_INPUT', `${where}.amount must be a non-zero safe integer`);
  }
}

// Net balance per account: original entries + correction deltas + compensation.
export function netBalances(batch) {
  const balances = new Map();
  const add = (account, amount) => balances.set(account, (balances.get(account) ?? 0) + amount);
  for (const entry of batch.entries) add(entry.account, entry.amount);
  for (const delta of batch.deltas) add(delta.account, delta.amount);
  for (const comp of batch.compensation) add(comp.account, comp.amount);
  return balances;
}

function nonZeroAccounts(balances) {
  const accounts = {};
  for (const key of [...balances.keys()].sort()) {
    const value = balances.get(key);
    if (value !== 0) accounts[key] = value;
  }
  return accounts;
}

// Effective amount of every known entryId after originals + materialized deltas.
function effectiveEntries(batch) {
  const map = new Map();
  for (const entry of batch.entries) {
    map.set(entry.entryId, { account: entry.account, amount: entry.amount });
  }
  for (const delta of batch.deltas) {
    if (delta.op === 'add') {
      map.set(delta.entryId, { account: delta.account, amount: delta.amount });
    } else {
      const current = map.get(delta.ref);
      current.amount += delta.amount;
    }
  }
  return map;
}

export function createBatch(state, cmd) {
  requireRequestId(cmd);
  if (typeof cmd.batchId !== 'string' || cmd.batchId.length === 0) {
    throw new LedgerError('INVALID_INPUT', 'batchId must be a non-empty string');
  }
  if (!Array.isArray(cmd.entries) || cmd.entries.length === 0) {
    throw new LedgerError('INVALID_INPUT', 'entries must be a non-empty array');
  }
  cmd.entries.forEach(validateEntry);
  const ids = new Set(cmd.entries.map((e) => e.entryId));
  if (ids.size !== cmd.entries.length) {
    throw new LedgerError('INVALID_INPUT', 'entryId values must be unique within a batch');
  }
  const existing = state.batches.get(cmd.batchId);
  if (existing && existing.version > 0) {
    const cached = cachedResult(existing, cmd.requestId);
    if (cached) return { events: [], result: cached };
    throw new LedgerError('BATCH_EXISTS', `batch already exists: ${cmd.batchId}`);
  }
  const entries = cmd.entries.map((e) => ({ entryId: e.entryId, account: e.account, amount: e.amount }));
  const frozenTotal = entries.reduce((sum, e) => sum + e.amount, 0);
  const result = { batchId: cmd.batchId, version: 1, status: 'open', frozenTotal };
  const event = {
    type: 'batch_created',
    batchId: cmd.batchId,
    requestId: cmd.requestId,
    entries,
    frozenTotal,
    result,
  };
  return { events: [event], result };
}

function materializeCorrections(batch, corrections) {
  const effective = effectiveEntries(batch);
  const deltas = [];
  corrections.forEach((correction, index) => {
    const where = `corrections[${index}]`;
    if (correction === null || typeof correction !== 'object' || !CORRECTION_TYPES.has(correction.type)) {
      throw new LedgerError('INVALID_INPUT', `${where}.type must be one of add|reverse|adjust`);
    }
    if (correction.type === 'add') {
      validateEntry(correction, index);
      if (effective.has(correction.entryId)) {
        throw new LedgerError('DUPLICATE_ENTRY', `entry already exists: ${correction.entryId}`);
      }
      effective.set(correction.entryId, { account: correction.account, amount: correction.amount });
      deltas.push({ op: 'add', entryId: correction.entryId, account: correction.account, amount: correction.amount });
    } else if (correction.type === 'reverse') {
      if (typeof correction.entryId !== 'string' || !effective.has(correction.entryId)) {
        throw new LedgerError('ENTRY_NOT_FOUND', `entry not found: ${correction.entryId}`);
      }
      const current = effective.get(correction.entryId);
      deltas.push({ op: 'reverse', ref: correction.entryId, account: current.account, amount: -current.amount });
      current.amount = 0;
    } else {
      if (typeof correction.entryId !== 'string' || !effective.has(correction.entryId)) {
        throw new LedgerError('ENTRY_NOT_FOUND', `entry not found: ${correction.entryId}`);
      }
      if (!Number.isSafeInteger(correction.newAmount)) {
        throw new LedgerError('INVALID_INPUT', `${where}.newAmount must be a safe integer`);
      }
      const current = effective.get(correction.entryId);
      deltas.push({
        op: 'adjust',
        ref: correction.entryId,
        account: current.account,
        amount: correction.newAmount - current.amount,
      });
      current.amount = correction.newAmount;
    }
  });
  return deltas;
}

export function applyCorrection(state, cmd) {
  requireRequestId(cmd);
  const batch = getBatch(state, cmd.batchId);
  const cached = cachedResult(batch, cmd.requestId);
  if (cached) return { events: [], result: cached };
  if (batch.status !== 'open') {
    throw new LedgerError('BATCH_NOT_OPEN', `batch ${cmd.batchId} is ${batch.status}; corrections rejected`);
  }
  if (!Number.isSafeInteger(cmd.version) || cmd.version !== batch.version + 1) {
    throw new LedgerError(
      'VERSION_CONFLICT',
      `stale or gapped version: expected ${batch.version + 1}, got ${cmd.version}`,
    );
  }
  if (!Array.isArray(cmd.corrections) || cmd.corrections.length === 0) {
    throw new LedgerError('INVALID_INPUT', 'corrections must be a non-empty array');
  }
  const deltas = materializeCorrections(batch, cmd.corrections);
  const result = { batchId: cmd.batchId, version: cmd.version, status: 'open', applied: deltas.length };
  const event = {
    type: 'correction_applied',
    batchId: cmd.batchId,
    requestId: cmd.requestId,
    version: cmd.version,
    corrections: cmd.corrections,
    deltas,
    result,
  };
  return { events: [event], result };
}

function buildCertificate(batch) {
  const body = {
    batchId: batch.batchId,
    version: batch.version,
    frozenTotal: batch.frozenTotal,
    accounts: nonZeroAccounts(netBalances(batch)),
  };
  return { ...body, hash: hashObject(body) };
}

export function confirmBatch(state, cmd) {
  requireRequestId(cmd);
  const batch = getBatch(state, cmd.batchId);
  const cached = cachedResult(batch, cmd.requestId);
  if (cached) return { events: [], result: cached };
  if (batch.status !== 'open') {
    throw new LedgerError('BATCH_NOT_OPEN', `batch ${cmd.batchId} is ${batch.status}; cannot confirm`);
  }
  const certificate = buildCertificate(batch);
  const result = { batchId: cmd.batchId, status: 'confirmed', certificate };
  const event = {
    type: 'confirmed',
    batchId: cmd.batchId,
    requestId: cmd.requestId,
    version: batch.version,
    certificate,
    result,
  };
  return { events: [event], result };
}

export function cancelBatch(state, cmd) {
  requireRequestId(cmd);
  const batch = getBatch(state, cmd.batchId);
  const cached = cachedResult(batch, cmd.requestId);
  if (cached) return { events: [], result: cached };
  if (batch.status === 'cancelled') {
    throw new LedgerError('BATCH_CANCELLED', `batch ${cmd.batchId} is already cancelled`);
  }
  if (batch.status === 'open') {
    const result = {
      batchId: cmd.batchId,
      status: 'cancelled',
      mode: 'release',
      released: batch.frozenTotal,
    };
    const event = {
      type: 'cancelled',
      batchId: cmd.batchId,
      requestId: cmd.requestId,
      mode: 'release',
      result,
    };
    return { events: [event], result };
  }
  const compensation = Object.entries(nonZeroAccounts(netBalances(batch))).map(([account, net]) => ({
    account,
    amount: -net,
  }));
  const result = { batchId: cmd.batchId, status: 'cancelled', mode: 'compensate', compensation };
  const event = {
    type: 'cancelled',
    batchId: cmd.batchId,
    requestId: cmd.requestId,
    mode: 'compensate',
    compensation,
    result,
  };
  return { events: [event], result };
}

export function batchStatus(state, batchId) {
  const batch = getBatch(state, batchId);
  return {
    batchId: batch.batchId,
    version: batch.version,
    status: batch.status,
    frozenTotal: batch.frozenTotal,
    balances: nonZeroAccounts(netBalances(batch)),
    certificate: batch.certificate,
    compensation: batch.compensation,
  };
}

export const COMMANDS = {
  'create-batch': createBatch,
  'apply-correction': applyCorrection,
  confirm: confirmBatch,
  cancel: cancelBatch,
};

export function execute(state, commandName, cmd) {
  const handler = COMMANDS[commandName];
  if (!handler) throw new LedgerError('UNKNOWN_COMMAND', `unknown command: ${commandName}`);
  return handler(state, cmd);
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class MarginCallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarginCallError';
    this.code = code;
  }
}

export class SimulatedCrashError extends Error {
  constructor(callId, accountIndex) {
    super(`simulated crash after freeze record of account index ${accountIndex} was persisted`);
    this.name = 'SimulatedCrashError';
    this.callId = callId;
    this.accountIndex = accountIndex;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new MarginCallError('INVALID_EVENT', 'event must be a JSON object');
  }
  if (typeof event.callId !== 'string' || event.callId.length === 0) {
    throw new MarginCallError('INVALID_EVENT', 'callId must be a non-empty string');
  }
  if (!Number.isInteger(event.targetAmount) || event.targetAmount < 0) {
    throw new MarginCallError('INVALID_EVENT', 'targetAmount must be a non-negative integer');
  }
  if (!Array.isArray(event.accounts)) {
    throw new MarginCallError('INVALID_EVENT', 'accounts must be an array');
  }
  const seen = new Set();
  for (const account of event.accounts) {
    if (!account || typeof account !== 'object') {
      throw new MarginCallError('INVALID_EVENT', 'each account must be an object');
    }
    if (typeof account.id !== 'string' || account.id.length === 0) {
      throw new MarginCallError('INVALID_EVENT', 'account.id must be a non-empty string');
    }
    if (seen.has(account.id)) {
      throw new MarginCallError('INVALID_EVENT', `duplicate account id: ${account.id}`);
    }
    seen.add(account.id);
    if (typeof account.priority !== 'number' || !Number.isFinite(account.priority)) {
      throw new MarginCallError('INVALID_EVENT', `account ${account.id}: priority must be a finite number`);
    }
    if (!Number.isInteger(account.available) || account.available < 0) {
      throw new MarginCallError('INVALID_EVENT', `account ${account.id}: available must be a non-negative integer`);
    }
  }
  const faults = event.faults ?? {};
  if (typeof faults !== 'object' || faults === null || Array.isArray(faults)) {
    throw new MarginCallError('INVALID_EVENT', 'faults must be an object when present');
  }
  for (const key of ['crashAfterAccount', 'cancelAfterAccount']) {
    const value = faults[key];
    if (value != null && !Number.isInteger(value)) {
      throw new MarginCallError('INVALID_EVENT', `faults.${key} must be an integer or null`);
    }
  }
}

function eventFingerprint(event) {
  return sha256(stableStringify({
    callId: event.callId,
    targetAmount: event.targetAmount,
    accounts: event.accounts.map((a) => ({ id: a.id, priority: a.priority, available: a.available })),
  }));
}

function persistJournal(logDir, journalPath, journal) {
  const tmpPath = `${journalPath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(journal, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, journalPath);
}

function buildCertificate(callId, targetAmount, freezes) {
  const totalFrozen = freezes.reduce((sum, f) => sum + f.amount, 0);
  const body = { callId, targetAmount, totalFrozen, freezes };
  return { ...body, digest: sha256(stableStringify(body)) };
}

function computeNetFrozen(journal) {
  const net = new Map();
  for (const f of journal.freezes) net.set(f.accountId, (net.get(f.accountId) ?? 0) + f.amount);
  for (const r of journal.rollbacks) net.set(r.accountId, (net.get(r.accountId) ?? 0) - r.amount);
  return Object.fromEntries(net);
}

function byPriorityThenId(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Execute (or resume) a margin call.
 *
 * @param {object} event { callId, targetAmount, accounts: [{id, priority, available}],
 *                         faults?: { crashAfterAccount?: number|null, cancelAfterAccount?: number|null } }
 * @param {string} logDir directory holding the per-callId journal
 * @returns result object; throws SimulatedCrashError when the injected crash fires
 *          (re-invoke with the same event and logDir to resume).
 */
export function runMarginCall(event, logDir) {
  validateEvent(event);
  fs.mkdirSync(logDir, { recursive: true });
  const journalPath = path.join(logDir, `journal-${sha256(event.callId)}.json`);
  const fingerprint = eventFingerprint(event);

  let journal = null;
  if (fs.existsSync(journalPath)) {
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    } catch {
      throw new MarginCallError('JOURNAL_CORRUPT', `journal for callId ${event.callId} is not valid JSON`);
    }
    if (journal.eventHash !== fingerprint) {
      throw new MarginCallError('CALL_ID_CONFLICT', `callId ${event.callId} was already used with a different event`);
    }
    if (journal.status === 'DONE') return journal.result;
  } else {
    journal = {
      callId: event.callId,
      eventHash: fingerprint,
      status: 'IN_PROGRESS',
      attempts: [],
      freezes: [],
      rollbacks: [],
      cancelled: false,
    };
    persistJournal(logDir, journalPath, journal);
  }

  const sorted = [...event.accounts].sort(byPriorityThenId);
  const faults = event.faults ?? {};
  const cancelAt = faults.cancelAfterAccount ?? null;
  const processed = new Set(journal.attempts.map((a) => a.accountId));
  let totalFrozen = journal.freezes.reduce((sum, f) => sum + f.amount, 0);

  if (!journal.cancelled) {
    for (let i = 0; i < sorted.length; i++) {
      const account = sorted[i];
      if (processed.has(account.id)) continue;
      if (cancelAt != null && i > cancelAt) {
        journal.cancelled = true;
        persistJournal(logDir, journalPath, journal);
        break;
      }
      if (totalFrozen >= event.targetAmount) break;
      const requested = event.targetAmount - totalFrozen;
      const amount = Math.min(requested, account.available);
      journal.attempts.push({ seq: i, accountId: account.id, requested, amount, ok: amount >= requested });
      if (amount > 0) journal.freezes.push({ accountId: account.id, amount });
      totalFrozen += amount;
      persistJournal(logDir, journalPath, journal);
      if (faults.crashAfterAccount === i) {
        throw new SimulatedCrashError(event.callId, i);
      }
    }
  }

  let result;
  if (!journal.cancelled && totalFrozen >= event.targetAmount) {
    const certificate = buildCertificate(event.callId, event.targetAmount, journal.freezes);
    result = {
      callId: event.callId,
      status: 'CONFIRMED',
      targetAmount: event.targetAmount,
      totalFrozen,
      freezes: journal.freezes,
      rollbacks: [],
      netFrozen: computeNetFrozen(journal),
      certificate,
    };
  } else {
    const reversed = [...journal.freezes].reverse();
    for (let k = journal.rollbacks.length; k < reversed.length; k++) {
      journal.rollbacks.push({ accountId: reversed[k].accountId, amount: reversed[k].amount });
      persistJournal(logDir, journalPath, journal);
    }
    result = {
      callId: event.callId,
      status: journal.cancelled ? 'CANCELLED' : 'FAILED',
      targetAmount: event.targetAmount,
      totalFrozen,
      freezes: journal.freezes,
      rollbacks: journal.rollbacks,
      netFrozen: computeNetFrozen(journal),
      certificate: null,
    };
  }

  journal.status = 'DONE';
  journal.result = result;
  persistJournal(logDir, journalPath, journal);
  return result;
}

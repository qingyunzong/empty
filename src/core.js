import { createHash } from 'node:crypto';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',');
  return `{${body}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeNets(entries) {
  const totals = new Map();
  for (const entry of entries) {
    totals.set(entry.accountId, (totals.get(entry.accountId) ?? 0) + entry.amount);
  }
  return [...totals.entries()]
    .map(([accountId, amount]) => ({ accountId, amount }))
    .sort((x, y) => compareStrings(x.accountId, y.accountId));
}

export function buildCertificate(batchId, version, entries) {
  const body = { batchId, version, nets: computeNets(entries) };
  return { ...body, hash: sha256Hex(canonicalize(body)) };
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('VALIDATION_ERROR', `${field} must be a non-empty string`);
  }
  return value;
}

function requireAmount(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) {
    throw new LedgerError(
      'VALIDATION_ERROR',
      `${field} must be a ${allowZero ? '' : 'non-zero '}safe integer`,
    );
  }
  return value;
}

const STATE_RANK = { OPEN: 0, CONFIRMED: 1, REVOKED: 2, COMPENSATED: 2 };

export class Ledger {
  constructor() {
    this.events = [];
    this.batches = new Map();
    this.requests = new Map();
  }

  static replay(events) {
    const ledger = new Ledger();
    for (const event of events) {
      ledger.apply(event);
    }
    return ledger;
  }

  #skeleton(batchId) {
    let batch = this.batches.get(batchId);
    if (!batch) {
      batch = {
        batchId,
        version: 0,
        state: 'OPEN',
        frozenTotal: 0,
        entries: [],
        certificate: null,
      };
      this.batches.set(batchId, batch);
    }
    return batch;
  }

  #raiseState(batch, state) {
    if (STATE_RANK[state] > STATE_RANK[batch.state]) {
      batch.state = state;
    }
  }

  apply(event) {
    this.events.push(event);
    if (event.requestId !== undefined) {
      this.requests.set(event.requestId, event.result);
    }
    switch (event.type) {
      case 'BATCH_CREATED': {
        const batch = this.#skeleton(event.batchId);
        batch.version = Math.max(batch.version, event.version);
        batch.frozenTotal = event.frozenTotal;
        batch.entries.push(...event.entries.map((entry) => ({ ...entry })));
        break;
      }
      case 'CORRECTION_APPLIED': {
        const batch = this.#skeleton(event.batchId);
        batch.version = Math.max(batch.version, event.version);
        batch.entries.push(...event.deltas.map((entry) => ({ ...entry })));
        break;
      }
      case 'BATCH_CONFIRMED': {
        const batch = this.#skeleton(event.batchId);
        batch.version = Math.max(batch.version, event.version);
        batch.certificate = event.certificate;
        this.#raiseState(batch, 'CONFIRMED');
        break;
      }
      case 'BATCH_REVOKED': {
        const batch = this.#skeleton(event.batchId);
        this.#raiseState(batch, 'REVOKED');
        break;
      }
      case 'COMPENSATION_APPLIED': {
        const batch = this.#skeleton(event.batchId);
        batch.entries.push(...event.entries.map((entry) => ({ ...entry })));
        this.#raiseState(batch, 'COMPENSATED');
        break;
      }
      default:
        throw new LedgerError('UNKNOWN_EVENT', `unknown event type: ${event.type}`);
    }
  }

  #record(event) {
    const full = { seq: this.events.length + 1, ...event };
    this.apply(full);
    return full.result;
  }

  #cached(requestId) {
    requireString(requestId, 'requestId');
    return this.requests.has(requestId) ? this.requests.get(requestId) : null;
  }

  #mustGet(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new LedgerError('BATCH_NOT_FOUND', `batch not found: ${batchId}`);
    }
    return batch;
  }

  #nextEntryId(batch, offset) {
    return `e${batch.entries.length + offset}`;
  }

  createBatch(input) {
    const { batchId, entries, requestId } = input ?? {};
    const cached = this.#cached(requestId);
    if (cached) return cached;
    requireString(batchId, 'batchId');
    if (this.batches.has(batchId)) {
      throw new LedgerError('BATCH_EXISTS', `batch already exists: ${batchId}`);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new LedgerError('VALIDATION_ERROR', 'entries must be a non-empty array');
    }
    const prepared = entries.map((entry, index) => ({
      entryId: `e${index + 1}`,
      accountId: requireString(entry?.accountId, `entries[${index}].accountId`),
      amount: requireAmount(entry?.amount, `entries[${index}].amount`),
    }));
    const frozenTotal = prepared.reduce((sum, entry) => sum + entry.amount, 0);
    const result = { batchId, version: 1, state: 'OPEN', frozenTotal };
    return this.#record({
      type: 'BATCH_CREATED',
      batchId,
      version: 1,
      requestId,
      entries: prepared,
      frozenTotal,
      result,
    });
  }

  applyCorrection(input) {
    const { batchId, baseVersion, corrections, requestId } = input ?? {};
    const cached = this.#cached(requestId);
    if (cached) return cached;
    requireString(batchId, 'batchId');
    const batch = this.#mustGet(batchId);
    if (batch.state !== 'OPEN') {
      throw new LedgerError(
        'INVALID_STATE',
        `batch ${batchId} is ${batch.state}; corrections require OPEN`,
      );
    }
    if (!Number.isSafeInteger(baseVersion) || baseVersion !== batch.version) {
      throw new LedgerError(
        'VERSION_CONFLICT',
        `correction bases on version ${baseVersion} but batch ${batchId} is at version ${batch.version}`,
      );
    }
    if (!Array.isArray(corrections) || corrections.length === 0) {
      throw new LedgerError('VALIDATION_ERROR', 'corrections must be a non-empty array');
    }
    const deltas = [];
    corrections.forEach((correction, index) => {
      const entryId = this.#nextEntryId(batch, deltas.length + 1);
      const op = correction?.op;
      if (op === 'add') {
        deltas.push({
          entryId,
          accountId: requireString(correction.accountId, `corrections[${index}].accountId`),
          amount: requireAmount(correction.amount, `corrections[${index}].amount`),
        });
        return;
      }
      if (op === 'reverse' || op === 'adjust') {
        const target = batch.entries.find((entry) => entry.entryId === correction.entryId);
        if (!target) {
          throw new LedgerError(
            'ENTRY_NOT_FOUND',
            `entry not found in batch ${batchId}: ${correction.entryId}`,
          );
        }
        if (op === 'reverse') {
          deltas.push({
            entryId,
            accountId: target.accountId,
            amount: -target.amount,
            reversalOf: target.entryId,
          });
        } else {
          const newAmount = requireAmount(correction.amount, `corrections[${index}].amount`, {
            allowZero: true,
          });
          deltas.push({
            entryId,
            accountId: target.accountId,
            amount: newAmount - target.amount,
            adjustmentOf: target.entryId,
          });
        }
        return;
      }
      throw new LedgerError('VALIDATION_ERROR', `unknown correction op: ${op}`);
    });
    const version = batch.version + 1;
    const result = {
      batchId,
      version,
      state: 'OPEN',
      nets: computeNets([...batch.entries, ...deltas]),
    };
    return this.#record({
      type: 'CORRECTION_APPLIED',
      batchId,
      version,
      baseVersion,
      requestId,
      deltas,
      result,
    });
  }

  confirmBatch(input) {
    const { batchId, requestId } = input ?? {};
    const cached = this.#cached(requestId);
    if (cached) return cached;
    requireString(batchId, 'batchId');
    const batch = this.#mustGet(batchId);
    if (batch.state !== 'OPEN') {
      throw new LedgerError(
        'INVALID_STATE',
        `batch ${batchId} is ${batch.state}; confirmation requires OPEN`,
      );
    }
    const certificate = buildCertificate(batchId, batch.version, batch.entries);
    const result = { batchId, version: batch.version, state: 'CONFIRMED', certificate };
    return this.#record({
      type: 'BATCH_CONFIRMED',
      batchId,
      version: batch.version,
      requestId,
      certificate,
      result,
    });
  }

  revokeBatch(input) {
    const { batchId, requestId } = input ?? {};
    const cached = this.#cached(requestId);
    if (cached) return cached;
    requireString(batchId, 'batchId');
    const batch = this.#mustGet(batchId);
    if (batch.state === 'OPEN') {
      const result = {
        batchId,
        version: batch.version,
        state: 'REVOKED',
        releasedFreeze: batch.frozenTotal,
      };
      return this.#record({
        type: 'BATCH_REVOKED',
        batchId,
        version: batch.version,
        requestId,
        releasedFreeze: batch.frozenTotal,
        result,
      });
    }
    if (batch.state === 'CONFIRMED') {
      const compensationEntries = computeNets(batch.entries)
        .filter((net) => net.amount !== 0)
        .map((net, index) => ({
          entryId: this.#nextEntryId(batch, index + 1),
          accountId: net.accountId,
          amount: -net.amount,
          compensation: true,
        }));
      const result = {
        batchId,
        version: batch.version,
        state: 'COMPENSATED',
        compensationEntries,
        nets: computeNets([...batch.entries, ...compensationEntries]),
      };
      return this.#record({
        type: 'COMPENSATION_APPLIED',
        batchId,
        version: batch.version,
        requestId,
        entries: compensationEntries,
        result,
      });
    }
    throw new LedgerError(
      'INVALID_STATE',
      `batch ${batchId} is ${batch.state}; cannot revoke`,
    );
  }

  getBatch(batchId) {
    const batch = this.#mustGet(batchId);
    return {
      batchId: batch.batchId,
      version: batch.version,
      state: batch.state,
      frozenTotal: batch.frozenTotal,
      entries: batch.entries.map((entry) => ({ ...entry })),
      nets: computeNets(batch.entries),
      certificate: batch.certificate,
    };
  }

  getCertificate(batchId) {
    const batch = this.#mustGet(batchId);
    if (!batch.certificate) {
      throw new LedgerError('INVALID_STATE', `batch ${batchId} is not confirmed`);
    }
    return batch.certificate;
  }

  auditTrail(batchId) {
    this.#mustGet(batchId);
    return this.events
      .filter((event) => event.batchId === batchId)
      .map((event) => ({ ...event }));
  }
}

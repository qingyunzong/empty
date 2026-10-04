import path from 'node:path';
import { Wal } from './wal.js';
import { StoreError } from './errors.js';

export const EVENT_TYPES = Object.freeze(['start', 'stop', 'alarm', 'count']);

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new StoreError('E_ARGS', 'event must be a JSON object');
  }
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    throw new StoreError('E_ARGS', 'event.eventId must be a non-empty string');
  }
  if (typeof event.deviceId !== 'string' || event.deviceId.length === 0) {
    throw new StoreError('E_ARGS', 'event.deviceId must be a non-empty string');
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new StoreError('E_ARGS', 'event.seq must be a non-negative integer');
  }
  if (!EVENT_TYPES.includes(event.type)) {
    throw new StoreError('E_ARGS', `event.type must be one of ${EVENT_TYPES.join('|')}`);
  }
}

function deviceSeqKey(deviceId, seq) {
  return `${deviceId}${seq}`;
}

export class EventStore {
  constructor(dir) {
    this.dir = dir;
    this.wal = new Wal(path.join(dir, 'wal.log'));
    this.byId = new Map(); // primary index: eventId -> event
    this.byDeviceSeq = new Map(); // secondary index: deviceId+seq -> event
    this.lastRecovery = null;
  }

  // Opens the WAL, recovers (truncates any uncommitted/corrupt tail) and
  // rebuilds both indexes from the surviving committed records.
  open() {
    this.wal.open();
    const { records, truncatedBytes } = this.wal.recover();
    for (const record of records) {
      this.#index(JSON.parse(record.payload.toString('utf8')));
    }
    this.lastRecovery = { records: records.length, truncatedBytes };
    return this;
  }

  close() {
    this.wal.close();
  }

  #index(event) {
    this.byId.set(event.eventId, event);
    const key = deviceSeqKey(event.deviceId, event.seq);
    if (!this.byDeviceSeq.has(key)) {
      this.byDeviceSeq.set(key, event);
    }
  }

  append(event, opts = {}) {
    validateEvent(event);
    if (this.byId.has(event.eventId)) {
      throw new StoreError('E_DUP', `duplicate eventId: ${event.eventId}`);
    }
    const payload = Buffer.from(JSON.stringify(event), 'utf8');
    const { seq } = this.wal.append(payload, opts);
    this.#index(event);
    return { ok: true, seq };
  }

  get(eventId) {
    const event = this.byId.get(eventId);
    if (event === undefined) {
      throw new StoreError('E_NOTFOUND', `unknown eventId: ${eventId}`);
    }
    return event;
  }

  // Query by deviceId+seq (exact) or, when seq is omitted, all events of a
  // device ordered by seq.
  query({ deviceId, seq } = {}) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new StoreError('E_ARGS', 'query.deviceId must be a non-empty string');
    }
    if (seq === undefined || seq === null) {
      return [...this.byId.values()]
        .filter((event) => event.deviceId === deviceId)
        .sort((a, b) => a.seq - b.seq);
    }
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new StoreError('E_ARGS', 'query.seq must be a non-negative integer');
    }
    const event = this.byDeviceSeq.get(deviceSeqKey(deviceId, seq));
    if (event === undefined) {
      throw new StoreError('E_NOTFOUND', `no event for deviceId=${deviceId} seq=${seq}`);
    }
    return event;
  }

  recover() {
    const { records, truncatedBytes } = this.wal.recover();
    this.byId.clear();
    this.byDeviceSeq.clear();
    for (const record of records) {
      this.#index(JSON.parse(record.payload.toString('utf8')));
    }
    this.lastRecovery = { records: records.length, truncatedBytes };
    return this.lastRecovery;
  }
}

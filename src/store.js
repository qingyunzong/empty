/**
 * MVCC event store (single node, offline, stdlib only).
 *
 * Model:
 *  - eventId  identifies the business event.
 *  - validAt  is when the event actually happened (device time).
 *  - txAt     is the store's logical commit clock (monotonic, 1 per committed write).
 *
 * Every write (create / correct / delete) auto-commits as its own transaction and
 * appends a new version to the event's version chain. Corrections never overwrite
 * history. Deletes append a tombstone version. A snapshot captures the commit clock
 * at its begin and always reads the latest version with txAt <= its begin timestamp.
 *
 * Secondary indexes:
 *  - (eventId)              -> version chain lookup.
 *  - (deviceId, validAt)    -> sorted index with one entry per committed live
 *                              version, so a correction that moves validAt "migrates"
 *                              the index by adding a new entry while old entries stay
 *                              visible to old snapshots. Range scans resolve MVCC
 *                              visibility per candidate, so each snapshot sees its own
 *                              consistent view. No vacuum/GC is performed.
 */

export const E_DUP = 'E_DUP';
export const E_NOTFOUND = 'E_NOTFOUND';
export const E_INVALID = 'E_INVALID';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StoreError(E_INVALID, `${field} must be a non-empty string`);
  }
  return value;
}

function parseTime(value, field, { allowInfinity = false } = {}) {
  if (typeof value === 'number') {
    if (Number.isNaN(value) || (!allowInfinity && !Number.isFinite(value))) {
      throw new StoreError(E_INVALID, `${field} must be a finite number (epoch ms)`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new StoreError(E_INVALID, `${field} is not a valid timestamp: ${value}`);
    }
    return ms;
  }
  throw new StoreError(E_INVALID, `${field} must be epoch-ms number or ISO-8601 string`);
}

function parseBound(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  return parseTime(value, field, { allowInfinity: true });
}

function publicView(version) {
  return {
    eventId: version.eventId,
    deviceId: version.deviceId,
    validAt: version.validAt,
    txAt: version.txAt,
    data: version.data,
  };
}

/** Sorted secondary index over (deviceId, validAt, eventId, txAt). */
class SortedIndex {
  #entries = [];

  static compare(a, b) {
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    if (a.validAt !== b.validAt) return a.validAt - b.validAt;
    if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
    return a.txAt - b.txAt;
  }

  insert(entry) {
    const entries = this.#entries;
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (SortedIndex.compare(entries[mid], entry) < 0) lo = mid + 1;
      else hi = mid;
    }
    entries.splice(lo, 0, entry);
  }

  /** Inclusive scan of entries with deviceId match and from <= validAt <= to. */
  *scan(deviceId, from, to) {
    const entries = this.#entries;
    const probe = { deviceId, validAt: from, eventId: '', txAt: 0 };
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (SortedIndex.compare(entries[mid], probe) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.deviceId !== deviceId || entry.validAt > to) break;
      yield entry;
    }
  }
}

export class EventStore {
  #clock = 0;
  #chains = new Map(); // eventId -> Version[] ascending by txAt
  #index = new SortedIndex();

  /** Current commit clock value (also the txAt of the last committed write). */
  get clock() {
    return this.#clock;
  }

  create(input) {
    if (input === null || typeof input !== 'object') {
      throw new StoreError(E_INVALID, 'create expects an object');
    }
    const eventId = requireString(input.eventId, 'eventId');
    const deviceId = requireString(input.deviceId, 'deviceId');
    const validAt = parseTime(input.validAt, 'validAt');
    const chain = this.#chains.get(eventId);
    if (chain && !chain[chain.length - 1].deleted) {
      throw new StoreError(E_DUP, `eventId already exists: ${eventId}`);
    }
    const data = input.data === undefined ? null : input.data;
    return this.#append(eventId, { deviceId, validAt, data, deleted: false });
  }

  correct(input) {
    if (input === null || typeof input !== 'object') {
      throw new StoreError(E_INVALID, 'correct expects an object');
    }
    const eventId = requireString(input.eventId, 'eventId');
    const head = this.#liveHead(eventId);
    if (!head) throw new StoreError(E_NOTFOUND, `no live event: ${eventId}`);
    const deviceId = input.deviceId === undefined ? head.deviceId : requireString(input.deviceId, 'deviceId');
    const validAt = input.validAt === undefined ? head.validAt : parseTime(input.validAt, 'validAt');
    const data = input.data === undefined ? head.data : input.data;
    return this.#append(eventId, { deviceId, validAt, data, deleted: false });
  }

  delete(eventId) {
    const id = requireString(eventId, 'eventId');
    const head = this.#liveHead(id);
    if (!head) throw new StoreError(E_NOTFOUND, `no live event: ${id}`);
    return this.#append(id, { deviceId: head.deviceId, validAt: head.validAt, data: null, deleted: true });
  }

  /** Begin a snapshot at the current commit clock. */
  snapshot() {
    return new Snapshot(this, this.#clock);
  }

  /** Convenience: read on a fresh snapshot. */
  get(eventId) {
    return this.snapshot().get(eventId);
  }

  /** Convenience: range query on a fresh snapshot. */
  range(deviceId, from, to) {
    return this.snapshot().range(deviceId, from, to);
  }

  #liveHead(eventId) {
    const chain = this.#chains.get(eventId);
    if (!chain) return null;
    const head = chain[chain.length - 1];
    return head.deleted ? null : head;
  }

  #append(eventId, fields) {
    const txAt = ++this.#clock;
    const version = { eventId, ...fields, txAt };
    let chain = this.#chains.get(eventId);
    if (!chain) {
      chain = [];
      this.#chains.set(eventId, chain);
    }
    chain.push(version);
    if (!version.deleted) {
      this.#index.insert({ deviceId: version.deviceId, validAt: version.validAt, eventId, txAt });
    }
    return publicView(version);
  }

  /** Latest version of eventId committed at or before snapTs; null if none or tombstoned. */
  visibleAt(eventId, snapTs) {
    const chain = this.#chains.get(eventId);
    if (!chain) return null;
    let lo = 0;
    let hi = chain.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chain[mid].txAt <= snapTs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    const version = chain[found];
    return version.deleted ? null : version;
  }

  scanIndex(deviceId, from, to) {
    return this.#index.scan(deviceId, from, to);
  }
}

export class Snapshot {
  #store;
  #ts;

  constructor(store, ts) {
    this.#store = store;
    this.#ts = ts;
  }

  /** Commit clock value captured when this snapshot began. */
  get ts() {
    return this.#ts;
  }

  /** Visible live version of eventId in this snapshot, or null. */
  get(eventId) {
    const id = requireString(eventId, 'eventId');
    const version = this.#store.visibleAt(id, this.#ts);
    return version ? publicView(version) : null;
  }

  /**
   * Events of deviceId with validAt in [from, to] (inclusive), visible and not
   * deleted in this snapshot, sorted by (validAt, eventId). Empty range -> [].
   */
  range(deviceId, from, to) {
    const id = requireString(deviceId, 'deviceId');
    const lo = parseBound(from, 'from', -Infinity);
    const hi = parseBound(to, 'to', Infinity);
    if (lo > hi) return [];
    const seen = new Set();
    const out = [];
    for (const entry of this.#store.scanIndex(id, lo, hi)) {
      if (seen.has(entry.eventId)) continue;
      seen.add(entry.eventId);
      const version = this.#store.visibleAt(entry.eventId, this.#ts);
      if (!version || version.deviceId !== id) continue;
      if (version.validAt < lo || version.validAt > hi) continue;
      out.push(publicView(version));
    }
    out.sort((a, b) => a.validAt - b.validAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    return out;
  }
}

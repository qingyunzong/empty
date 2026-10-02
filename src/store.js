export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function assertEventId(eventId) {
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new StoreError('E_INVAL', 'eventId must be a non-empty string');
  }
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new StoreError('E_INVAL', 'deviceId must be a non-empty string');
  }
}

function assertValidAt(validAt) {
  if (typeof validAt !== 'number' || !Number.isFinite(validAt)) {
    throw new StoreError('E_INVAL', 'validAt must be a finite number');
  }
}

function compareIndexEntries(a, b) {
  if (a.validAt !== b.validAt) return a.validAt - b.validAt;
  if (a.txAt !== b.txAt) return a.txAt - b.txAt;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function publicVersion(v) {
  return {
    eventId: v.eventId,
    deviceId: v.deviceId,
    validAt: v.validAt,
    data: structuredClone(v.data),
    txAt: v.txAt,
  };
}

export class Snapshot {
  constructor(store, tx) {
    this.store = store;
    this.tx = tx;
  }

  get(eventId) {
    return this.store.get(eventId, this.tx);
  }

  range(deviceId, from, to) {
    return this.store.range(deviceId, from, to, this.tx);
  }
}

export class MvccStore {
  constructor() {
    this.commitSeq = 0;
    this.chains = new Map();
    this.deviceIndex = new Map();
  }

  get currentTx() {
    return this.commitSeq;
  }

  snapshot() {
    return new Snapshot(this, this.commitSeq);
  }

  insert(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new StoreError('E_INVAL', 'event must be an object');
    }
    assertEventId(event.eventId);
    assertDeviceId(event.deviceId);
    assertValidAt(event.validAt);
    const latest = this._latestCommitted(event.eventId);
    if (latest && !latest.deleted) {
      throw new StoreError('E_DUP', `eventId already exists: ${event.eventId}`);
    }
    const version = this._commit({
      eventId: event.eventId,
      deviceId: event.deviceId,
      validAt: event.validAt,
      data: event.data === undefined ? null : structuredClone(event.data),
      deleted: false,
    });
    return { eventId: version.eventId, txAt: version.txAt };
  }

  correct(eventId, patch = {}) {
    assertEventId(eventId);
    const latest = this._latestCommitted(eventId);
    if (!latest || latest.deleted) {
      throw new StoreError('E_NOENT', `event not found: ${eventId}`);
    }
    const next = {
      eventId,
      deviceId: patch.deviceId === undefined ? latest.deviceId : patch.deviceId,
      validAt: patch.validAt === undefined ? latest.validAt : patch.validAt,
      data: patch.data === undefined ? latest.data : patch.data,
      deleted: false,
    };
    assertDeviceId(next.deviceId);
    assertValidAt(next.validAt);
    const version = this._commit({ ...next, data: structuredClone(next.data) });
    return { eventId: version.eventId, txAt: version.txAt };
  }

  delete(eventId) {
    assertEventId(eventId);
    const latest = this._latestCommitted(eventId);
    if (!latest || latest.deleted) {
      throw new StoreError('E_NOENT', `event not found: ${eventId}`);
    }
    const version = this._commit({
      eventId,
      deviceId: latest.deviceId,
      validAt: latest.validAt,
      data: latest.data,
      deleted: true,
    });
    return { eventId: version.eventId, txAt: version.txAt };
  }

  get(eventId, tx = this.commitSeq) {
    const v = this._visibleAt(eventId, tx);
    return v && !v.deleted ? publicVersion(v) : null;
  }

  range(deviceId, from, to, tx = this.commitSeq) {
    if (typeof from !== 'number' || typeof to !== 'number' || !(from <= to)) {
      return [];
    }
    const entries = this.deviceIndex.get(deviceId);
    if (!entries) return [];
    const best = new Map();
    for (const entry of entries) {
      if (entry.txAt > tx) continue;
      if (entry.validAt < from || entry.validAt > to) continue;
      const cur = best.get(entry.eventId);
      if (!cur || entry.txAt > cur.txAt || (entry.txAt === cur.txAt && entry.live && !cur.live)) {
        best.set(entry.eventId, entry);
      }
    }
    const out = [];
    for (const [eventId, entry] of best) {
      if (!entry.live) continue;
      const v = this._visibleAt(eventId, tx);
      if (v && !v.deleted) out.push(publicVersion(v));
    }
    out.sort((a, b) =>
      a.validAt - b.validAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    return out;
  }

  _latestCommitted(eventId) {
    const chain = this.chains.get(eventId);
    return chain && chain.length ? chain[chain.length - 1] : null;
  }

  _visibleAt(eventId, tx) {
    const chain = this.chains.get(eventId);
    if (!chain) return null;
    let lo = 0;
    let hi = chain.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chain[mid].txAt <= tx) {
        found = chain[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  _commit(version) {
    version.txAt = ++this.commitSeq;
    let chain = this.chains.get(version.eventId);
    if (!chain) {
      chain = [];
      this.chains.set(version.eventId, chain);
    }
    const prev = chain.length ? chain[chain.length - 1] : null;
    chain.push(version);
    if (prev && !prev.deleted) {
      this._indexAppend({
        deviceId: prev.deviceId,
        validAt: prev.validAt,
        eventId: version.eventId,
        txAt: version.txAt,
        live: false,
      });
    }
    if (!version.deleted) {
      this._indexAppend({
        deviceId: version.deviceId,
        validAt: version.validAt,
        eventId: version.eventId,
        txAt: version.txAt,
        live: true,
      });
    }
    return version;
  }

  _indexAppend(entry) {
    let list = this.deviceIndex.get(entry.deviceId);
    if (!list) {
      list = [];
      this.deviceIndex.set(entry.deviceId, list);
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareIndexEntries(list[mid], entry) < 0) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, entry);
  }
}

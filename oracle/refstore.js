// Naive reference oracle: append-only version array, "sort by txAt + filter at snapshot".
function pub(v) {
  return {
    eventId: v.eventId,
    deviceId: v.deviceId,
    validAt: v.validAt,
    data: structuredClone(v.data),
    txAt: v.txAt,
  };
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

export class RefStore {
  constructor() {
    this.seq = 0;
    this.versions = [];
  }

  _latest(eventId) {
    let best = null;
    for (const v of this.versions) {
      if (v.eventId === eventId && (!best || v.txAt > best.txAt)) best = v;
    }
    return best;
  }

  _push(v) {
    v.txAt = ++this.seq;
    this.versions.push(v);
  }

  insert(e) {
    const latest = this._latest(e.eventId);
    if (latest && !latest.deleted) fail('E_DUP', `eventId already exists: ${e.eventId}`);
    this._push({
      eventId: e.eventId,
      deviceId: e.deviceId,
      validAt: e.validAt,
      data: e.data === undefined ? null : structuredClone(e.data),
      deleted: false,
    });
  }

  correct(eventId, patch = {}) {
    const latest = this._latest(eventId);
    if (!latest || latest.deleted) fail('E_NOENT', `event not found: ${eventId}`);
    this._push({
      eventId,
      deviceId: patch.deviceId === undefined ? latest.deviceId : patch.deviceId,
      validAt: patch.validAt === undefined ? latest.validAt : patch.validAt,
      data: patch.data === undefined ? latest.data : structuredClone(patch.data),
      deleted: false,
    });
  }

  delete(eventId) {
    const latest = this._latest(eventId);
    if (!latest || latest.deleted) fail('E_NOENT', `event not found: ${eventId}`);
    this._push({ ...latest, deleted: true });
  }

  getAt(eventId, tx) {
    let best = null;
    for (const v of this.versions) {
      if (v.eventId === eventId && v.txAt <= tx && (!best || v.txAt > best.txAt)) best = v;
    }
    return best && !best.deleted ? pub(best) : null;
  }

  rangeAt(deviceId, from, to, tx) {
    if (typeof from !== 'number' || typeof to !== 'number' || !(from <= to)) return [];
    const sorted = [...this.versions].sort((a, b) => a.txAt - b.txAt);
    const best = new Map();
    for (const v of sorted) {
      if (v.txAt > tx) break;
      best.set(v.eventId, v);
    }
    const out = [];
    for (const v of best.values()) {
      if (v.deleted) continue;
      if (v.deviceId !== deviceId) continue;
      if (v.validAt < from || v.validAt > to) continue;
      out.push(pub(v));
    }
    out.sort((a, b) =>
      a.validAt - b.validAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    return out;
  }
}

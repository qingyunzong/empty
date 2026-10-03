'use strict';

const { crc32 } = require('./crc32');

// Secondary indexes, kept in memory and persisted as standalone files.
// Serialized form: { walOffset, checksum, payload } where checksum is
// crc32 of the payload JSON. On startup an index is accepted only if the
// checksum matches and walOffset equals the replayed WAL end position.

class TypeIndex {
  constructor() {
    this.map = new Map(); // type -> Set<id>
  }

  add(sample) {
    let set = this.map.get(sample.type);
    if (!set) {
      set = new Set();
      this.map.set(sample.type, set);
    }
    set.add(sample.id);
  }

  remove(sample) {
    const set = this.map.get(sample.type);
    if (set) {
      set.delete(sample.id);
      if (set.size === 0) this.map.delete(sample.type);
    }
  }

  update(oldSample, newSample) {
    if (oldSample.type !== newSample.type) {
      this.remove(oldSample);
      this.add(newSample);
    }
  }

  lookup(type) {
    const set = this.map.get(type);
    return set ? [...set] : [];
  }

  toPayload() {
    const obj = {};
    for (const [type, ids] of [...this.map.entries()].sort()) {
      obj[type] = [...ids].sort();
    }
    return obj;
  }

  static fromPayload(obj) {
    const idx = new TypeIndex();
    for (const [type, ids] of Object.entries(obj)) {
      idx.map.set(type, new Set(ids));
    }
    return idx;
  }
}

class DateIndex {
  constructor() {
    this.map = new Map(); // date -> Set<id>
    this.sortedDates = []; // sorted unique dates, maintained incrementally
  }

  _insertDate(date) {
    let lo = 0;
    let hi = this.sortedDates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sortedDates[mid] < date) lo = mid + 1;
      else hi = mid;
    }
    this.sortedDates.splice(lo, 0, date);
  }

  _removeDate(date) {
    const i = this.sortedDates.indexOf(date);
    if (i !== -1) this.sortedDates.splice(i, 1);
  }

  add(sample) {
    let set = this.map.get(sample.date);
    if (!set) {
      set = new Set();
      this.map.set(sample.date, set);
      this._insertDate(sample.date);
    }
    set.add(sample.id);
  }

  remove(sample) {
    const set = this.map.get(sample.date);
    if (set) {
      set.delete(sample.id);
      if (set.size === 0) {
        this.map.delete(sample.date);
        this._removeDate(sample.date);
      }
    }
  }

  update(oldSample, newSample) {
    if (oldSample.date !== newSample.date) {
      this.remove(oldSample);
      this.add(newSample);
    }
  }

  // Inclusive [from, to] range; returns ids grouped by ascending date.
  range(from, to) {
    const ids = [];
    for (const date of this.sortedDates) {
      if (date < from) continue;
      if (date > to) break;
      for (const id of this.map.get(date)) ids.push(id);
    }
    return ids;
  }

  toPayload() {
    const obj = {};
    for (const date of this.sortedDates) {
      obj[date] = [...this.map.get(date)].sort();
    }
    return obj;
  }

  static fromPayload(obj) {
    const idx = new DateIndex();
    for (const [date, ids] of Object.entries(obj)) {
      idx.map.set(date, new Set(ids));
      idx.sortedDates.push(date);
    }
    idx.sortedDates.sort();
    return idx;
  }
}

function serializeIndex(index, walOffset) {
  const payload = JSON.stringify(index.toPayload());
  return JSON.stringify({
    walOffset,
    checksum: crc32(Buffer.from(payload, 'utf8')).toString(16).padStart(8, '0'),
    payload: JSON.parse(payload),
  });
}

// Returns the index instance if the file is present, the checksum is valid
// and the WAL position matches; otherwise null (caller must rebuild).
function deserializeIndex(raw, walOffset, IndexClass) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || doc.walOffset !== walOffset || typeof doc.checksum !== 'string') {
    return null;
  }
  const payload = JSON.stringify(doc.payload);
  const actual = crc32(Buffer.from(payload, 'utf8')).toString(16).padStart(8, '0');
  if (actual !== doc.checksum) return null;
  try {
    return IndexClass.fromPayload(doc.payload);
  } catch {
    return null;
  }
}

module.exports = { TypeIndex, DateIndex, serializeIndex, deserializeIndex };

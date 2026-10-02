'use strict';

const crypto = require('node:crypto');

class CorrectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CorrectionError';
    this.code = code;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function assertTimestampOrder(next, prev) {
  if (prev === null || prev === undefined) return;
  const ok = typeof next === 'number' && typeof prev === 'number'
    ? next > prev
    : String(next) > String(prev);
  if (!ok) {
    throw new CorrectionError(
      'OUT_OF_ORDER_TIMESTAMP',
      `correction timestamp ${JSON.stringify(next)} is not after previous timestamp ${JSON.stringify(prev)}`
    );
  }
}

class CorrectionLog {
  constructor(observations) {
    if (!Array.isArray(observations)) {
      throw new CorrectionError('INVALID_OBSERVATIONS', 'observations must be an array of {id, value}');
    }
    this.values = new Map();
    for (const obs of observations) {
      if (obs === null || typeof obs !== 'object' || typeof obs.id !== 'string') {
        throw new CorrectionError('INVALID_OBSERVATION', 'each observation needs a string id');
      }
      this.values.set(obs.id, obs.value);
    }
    this.entries = [];
    this.cursor = 0;
  }

  _requireObservation(observationId) {
    if (!this.values.has(observationId)) {
      throw new CorrectionError('UNKNOWN_OBSERVATION', `correction references unknown observation: ${observationId}`);
    }
  }

  apply(correction) {
    if (correction === null || typeof correction !== 'object') {
      throw new CorrectionError('INVALID_CORRECTION', 'correction must be an object');
    }
    const { id, observationId, timestamp, reason, author, newValue } = correction;
    for (const [field, val] of Object.entries({ id, observationId, reason, author })) {
      if (typeof val !== 'string' || val.length === 0) {
        throw new CorrectionError('INVALID_CORRECTION', `correction field ${field} must be a non-empty string`);
      }
    }
    if (timestamp === undefined || timestamp === null) {
      throw new CorrectionError('INVALID_CORRECTION', 'correction needs a timestamp');
    }
    this._requireObservation(observationId);
    const lastActive = this.cursor > 0 ? this.entries[this.cursor - 1] : null;
    assertTimestampOrder(timestamp, lastActive ? lastActive.timestamp : null);

    this.entries.length = this.cursor;
    const before = this.values.get(observationId);
    const entry = {
      id,
      observationId,
      timestamp,
      reason,
      author,
      before,
      after: newValue,
      status: 'active',
      compressed: false,
      compressedFrom: [id],
    };
    this.entries.push(entry);
    this.values.set(observationId, newValue);
    this.cursor = this.entries.length;
    return entry;
  }

  undo() {
    if (this.cursor === 0) {
      throw new CorrectionError('NOTHING_TO_UNDO', 'no active correction to undo');
    }
    const entry = this.entries[this.cursor - 1];
    entry.status = 'undone';
    this.values.set(entry.observationId, entry.before);
    this.cursor -= 1;
    return entry;
  }

  redo() {
    if (this.cursor >= this.entries.length) {
      throw new CorrectionError('NOTHING_TO_REDO', 'no undone correction to redo');
    }
    const entry = this.entries[this.cursor];
    entry.status = 'active';
    this.values.set(entry.observationId, entry.after);
    this.cursor += 1;
    return entry;
  }

  compress(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= this.entries.length) {
      throw new CorrectionError('INVALID_COMPRESS_RANGE', `invalid compression range [${start}, ${end}]`);
    }
    for (let i = start; i <= end; i += 1) {
      if (this.entries[i].status !== 'active') {
        throw new CorrectionError(
          'COMPRESS_RANGE_CONTAINS_UNDONE',
          `compression range [${start}, ${end}] contains undone correction ${this.entries[i].id}`
        );
      }
    }
    const slice = this.entries.slice(start, end + 1);
    const observationId = slice[0].observationId;
    for (const entry of slice) {
      if (entry.observationId !== observationId) {
        throw new CorrectionError(
          'COMPRESS_RANGE_MIXED_OBSERVATIONS',
          `compression range [${start}, ${end}] spans multiple observations`
        );
      }
    }
    const first = slice[0];
    const last = slice[slice.length - 1];
    const authors = [...new Set(slice.map((e) => e.author))];
    const merged = {
      id: slice.map((e) => e.id).join('+'),
      observationId,
      timestamp: last.timestamp,
      firstTimestamp: first.timestamp,
      reason: slice.map((e) => e.reason).join('+'),
      reasons: slice.map((e) => e.reason),
      author: authors.join('+'),
      authors,
      before: first.before,
      after: last.after,
      status: 'active',
      compressed: slice.length > 1,
      compressedFrom: slice.flatMap((e) => e.compressedFrom),
    };
    this.entries.splice(start, slice.length, merged);
    this.cursor -= slice.length - 1;
    return merged;
  }

  getState() {
    const state = {};
    for (const key of [...this.values.keys()].sort()) {
      state[key] = this.values.get(key);
    }
    return state;
  }

  stateHash() {
    return crypto.createHash('sha256').update(stableStringify(this.getState())).digest('hex');
  }

  auditMap() {
    const map = {};
    this.entries.forEach((entry, index) => {
      map[entry.id] = { auditIndex: index, originalIds: entry.compressedFrom.slice() };
    });
    return map;
  }

  getHistory() {
    return {
      cursor: this.cursor,
      entries: this.entries.map((entry, index) => ({ auditIndex: index, ...entry })),
    };
  }
}

module.exports = { CorrectionLog, CorrectionError, stableStringify };

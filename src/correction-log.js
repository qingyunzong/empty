'use strict';

const crypto = require('node:crypto');

class CorrectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CorrectionError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashState(pairs) {
  return crypto.createHash('sha256').update(canonicalize(pairs)).digest('hex');
}

class CorrectionLog {
  constructor(observations) {
    if (!Array.isArray(observations)) {
      throw new CorrectionError('BAD_INPUT', 'observations must be an array');
    }
    this.values = new Map();
    for (const obs of observations) {
      if (!obs || typeof obs.id !== 'string') {
        throw new CorrectionError('BAD_INPUT', 'each observation needs a string id');
      }
      this.values.set(obs.id, obs.value);
    }
    this.entries = [];
    this.cursor = 0;
    this.nextSeq = 1;
    this.compactions = [];
    this.idMap = {};
  }

  apply(correction) {
    const { timestamp, reason, author, observationId, after } = correction || {};
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      throw new CorrectionError('BAD_INPUT', 'correction needs a numeric timestamp');
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new CorrectionError('BAD_INPUT', 'correction needs a reason code');
    }
    if (typeof author !== 'string' || author.length === 0) {
      throw new CorrectionError('BAD_INPUT', 'correction needs an author');
    }
    if (!this.values.has(observationId)) {
      throw new CorrectionError(
        'UNKNOWN_OBSERVATION',
        `correction references unknown observation: ${observationId}`,
      );
    }
    if (this.cursor > 0 && timestamp < this.entries[this.cursor - 1].timestamp) {
      throw new CorrectionError(
        'OUT_OF_ORDER_TIMESTAMP',
        `timestamp ${timestamp} is before previous correction timestamp ${this.entries[this.cursor - 1].timestamp}`,
      );
    }
    if (this.cursor < this.entries.length) {
      this.entries.length = this.cursor;
    }
    const seq = this.nextSeq++;
    const entry = {
      seq,
      id: typeof correction.id === 'string' ? correction.id : `C${seq}`,
      timestamp,
      reasons: [reason],
      authors: [author],
      changes: [{ observationId, before: this.values.get(observationId), after }],
      mergedFrom: null,
    };
    this.values.set(observationId, after);
    this.entries.push(entry);
    this.cursor = this.entries.length;
    return entry;
  }

  undo() {
    if (this.cursor === 0) return false;
    this.cursor -= 1;
    const entry = this.entries[this.cursor];
    for (const change of entry.changes) {
      this.values.set(change.observationId, change.before);
    }
    return true;
  }

  redo() {
    if (this.cursor >= this.entries.length) return false;
    const entry = this.entries[this.cursor];
    for (const change of entry.changes) {
      this.values.set(change.observationId, change.after);
    }
    this.cursor += 1;
    return true;
  }

  compact(startSeq, endSeq) {
    if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || startSeq < 1 || endSeq < startSeq) {
      throw new CorrectionError('BAD_RANGE', `invalid compaction range [${startSeq}, ${endSeq}]`);
    }
    const startIdx = this.entries.findIndex((e) => e.seq === startSeq);
    const endIdx = this.entries.findIndex((e) => e.seq === endSeq);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      throw new CorrectionError('BAD_RANGE', `no contiguous entries for range [${startSeq}, ${endSeq}]`);
    }
    if (endIdx >= this.cursor) {
      throw new CorrectionError(
        'UNDONE_IN_RANGE',
        `compaction range [${startSeq}, ${endSeq}] contains undone corrections`,
      );
    }
    const merged = this.entries.slice(startIdx, endIdx + 1);
    const folded = new Map();
    const reasons = [];
    const authors = [];
    const mergedIds = [];
    const mergedSeqs = [];
    for (const entry of merged) {
      mergedIds.push(entry.id);
      mergedSeqs.push(entry.seq);
      reasons.push(...entry.reasons);
      for (const a of entry.authors) {
        if (!authors.includes(a)) authors.push(a);
      }
      for (const change of entry.changes) {
        const prev = folded.get(change.observationId);
        if (prev) {
          prev.after = change.after;
        } else {
          folded.set(change.observationId, {
            observationId: change.observationId,
            before: change.before,
            after: change.after,
          });
        }
      }
    }
    const seq = this.nextSeq++;
    const compacted = {
      seq,
      id: `C${seq}`,
      timestamp: merged[merged.length - 1].timestamp,
      reasons,
      authors,
      changes: [...folded.values()],
      mergedFrom: mergedIds,
    };
    this.entries.splice(startIdx, merged.length, compacted);
    this.cursor = this.cursor - merged.length + 1;
    for (const oldId of mergedIds) {
      this.idMap[oldId] = compacted.id;
    }
    this.compactions.push({
      id: compacted.id,
      mergedIds,
      mergedSeqs,
      range: [startSeq, endSeq],
    });
    return compacted;
  }

  state() {
    return [...this.values.entries()]
      .map(([id, value]) => ({ id, value }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  stateHash() {
    return hashState(this.state().map((o) => [o.id, o.value]));
  }

  history() {
    return {
      cursor: this.cursor,
      entries: this.entries.slice(0, this.cursor),
      undone: this.entries.slice(this.cursor),
      compactions: this.compactions,
      idMap: this.idMap,
      stateHash: this.stateHash(),
    };
  }
}

module.exports = { CorrectionLog, CorrectionError, canonicalize, hashState };

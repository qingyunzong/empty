// Durable store: an append-only log plus a separately persisted derived
// snapshot. Commit order is: validate -> append log (fsync) -> apply to the
// engine -> persist snapshot (tmp + rename + fsync).
//
// Crash semantics:
//   - crash before the log append: nothing was written, no effect;
//   - crash after the log append but before the snapshot persists: on the
//     next open the log tail beyond the snapshot is replayed automatically.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine } from './engine.js';
import { validateBatch, ValidationError } from './validate.js';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, 'events.log');
    this.statePath = path.join(dir, 'state.json');
    this.engine = new Engine();
    this.records = [];
    this.appliedSeq = 0;
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    if (fs.existsSync(store.logPath)) {
      store.records = fs
        .readFileSync(store.logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    }
    let applied = 0;
    if (fs.existsSync(store.statePath)) {
      const snapshot = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
      store.engine.load(snapshot);
      applied = snapshot.appliedSeq;
    }
    // Recovery: replay any log records not yet reflected in the snapshot.
    for (let i = applied; i < store.records.length; i++) {
      store.applyRecord(store.records[i]);
    }
    store.appliedSeq = store.records.length;
    if (store.appliedSeq !== applied) store.persist();
    return store;
  }

  applyRecord(record) {
    if (record.kind === 'batch') return this.engine.applyBatch(record);
    if (record.kind === 'undo') return this.engine.undo(record.undo_tx_id);
    throw new Error(`unknown record kind: ${JSON.stringify(record.kind)}`);
  }

  appendLog(record) {
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, stableStringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  persist() {
    const snapshot = { ...this.engine.serialize(), appliedSeq: this.appliedSeq };
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.statePath);
  }

  // Atomic batch commit. Validation happens before anything is written, so
  // an invalid batch leaves the log, the counts and the hash untouched.
  commit(input) {
    const batch = validateBatch(input); // throws ValidationError
    if (this.engine.txDeltas.has(batch.tx_id)) {
      throw new ValidationError([`tx_id: duplicate tx_id ${JSON.stringify(batch.tx_id)}`]);
    }
    const record = {
      kind: 'batch',
      tx_id: batch.tx_id,
      tx_time: batch.tx_time,
      events: batch.events,
    };
    this.appendLog(record); // crash point: after append, before persist
    const deltas = this.applyRecord(record);
    this.records.push(record);
    this.appliedSeq += 1;
    this.persist();
    return { txId: batch.tx_id, eventCount: batch.events.length, deltas };
  }

  undo(txId, meta = {}) {
    this.engine.assertUndoable(txId); // checked before anything is written
    const record = {
      kind: 'undo',
      tx_id: meta.tx_id ?? `undo-${txId}`,
      undo_tx_id: txId,
      tx_time: meta.tx_time ?? new Date().toISOString(),
    };
    this.appendLog(record);
    const deltas = this.applyRecord(record);
    this.records.push(record);
    this.appliedSeq += 1;
    this.persist();
    return deltas;
  }

  hash() {
    const digest = crypto.createHash('sha256');
    for (const record of this.records) digest.update(stableStringify(record) + '\n');
    return digest.digest('hex');
  }
}

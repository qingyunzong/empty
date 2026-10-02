import fs from 'node:fs';
import path from 'node:path';
import { recoverWal, WalWriter, WalError } from './wal.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const compoundKey = (device, key) => JSON.stringify([device, key]);
const splitCompoundKey = (ck) => JSON.parse(ck);

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.indexPath = path.join(dir, 'index.json');
    this.checkpointPath = path.join(dir, 'checkpoint.json');
    this.records = [];
    this.state = new Map(); // compoundKey -> value (live path)
    this.index = new Map(); // device -> Set<key> (live path, acceleration only)
    this.lastSeq = 0;
    this.writer = null;
  }

  // Open the store: recover the WAL (truncating any torn tail), rebuild the
  // live state from it, and load the persisted secondary index if present
  // (rebuilding and persisting it otherwise).
  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const { records, truncated } = recoverWal(this.walPath);
    this.records = records;
    this.truncatedOnRecovery = truncated;
    this.state = new Map();
    for (const record of records) {
      applyToState(this.state, record);
      this.lastSeq = record.seq;
    }
    const persisted = fs.existsSync(this.indexPath)
      ? JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
      : null;
    if (persisted && persisted.seq === this.lastSeq && !truncated) {
      this.index = indexFromJson(persisted.devices);
    } else {
      // The index is only an acceleration: whenever it is missing or stale
      // relative to the recovered WAL (crash, torn tail), rebuild it from
      // the WAL-derived state.
      this.index = deriveIndex(this.state);
      this.persistIndex();
    }
    this.writer = new WalWriter(this.walPath);
    return this;
  }

  close() {
    if (this.writer) this.writer.close();
    this.writer = null;
  }

  // Apply one logical change as its own transaction. Returns the record.
  apply({ device, key, value = null, del = false }, hooks = {}) {
    const ck = compoundKey(device, key);
    const oldValue = this.state.has(ck) ? this.state.get(ck) : null;
    const seq = this.lastSeq + 1;
    const record = {
      seq,
      txn: seq,
      op: del ? 'del' : 'set',
      device,
      key,
      oldValue,
      newValue: del ? null : value,
    };
    this.writer.append(record, hooks);
    this.records.push(record);
    this.lastSeq = seq;
    if (del) {
      this.state.delete(ck);
      this.index.get(device)?.delete(key);
    } else {
      this.state.set(ck, value);
      if (!this.index.has(device)) this.index.set(device, new Set());
      this.index.get(device).add(key);
    }
    this.persistIndex();
    return record;
  }

  persistIndex() {
    const payload = { seq: this.lastSeq, devices: indexToJson(this.index) };
    fs.writeFileSync(this.indexPath, JSON.stringify(payload));
  }

  // Rebuild the full state at transaction sequence `to` by replaying the WAL
  // from the newest checkpoint at or before `to`. This is the source of
  // truth; the live state and index are only accelerations of it.
  replay(to) {
    const maxSeq = this.lastSeq;
    if (to === undefined || to === null) to = maxSeq;
    if (!Number.isInteger(to) || to < 0 || to > maxSeq) {
      throw new StoreError('NO_SUCH_TXN', `no transaction with sequence ${to} (max ${maxSeq})`);
    }
    let state = new Map();
    let fromSeq = 0;
    if (fs.existsSync(this.checkpointPath)) {
      const checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
      if (checkpoint.seq <= to) {
        state = stateFromJson(checkpoint.state);
        fromSeq = checkpoint.seq;
      }
    }
    let expected = fromSeq + 1;
    for (const record of this.records) {
      if (record.seq <= fromSeq) continue;
      if (record.seq > to) break;
      if (record.seq !== expected) {
        throw new StoreError(
          'LOG_GAP',
          `expected record seq ${expected}, found ${record.seq}; log is not contiguous`,
        );
      }
      applyToState(state, record);
      expected++;
    }
    return { seq: to, state };
  }

  // Write a checkpoint: the full live state tagged with the current sequence.
  checkpoint() {
    const checkpoint = { seq: this.lastSeq, state: stateToJson(this.state) };
    fs.writeFileSync(this.checkpointPath, JSON.stringify(checkpoint));
    return checkpoint;
  }

  // Compare the persisted secondary index against the index derived from a
  // full WAL replay. Returns a list of divergences (empty when consistent).
  audit() {
    const { state } = this.replay(this.lastSeq);
    const truth = indexToJson(deriveIndex(state));
    const actual = fs.existsSync(this.indexPath)
      ? JSON.parse(fs.readFileSync(this.indexPath, 'utf8')).devices ?? {}
      : {};
    const divergences = [];
    const devices = new Set([...Object.keys(truth), ...Object.keys(actual)]);
    for (const device of [...devices].sort()) {
      const truthKeys = new Set(truth[device] ?? []);
      const actualKeys = new Set(actual[device] ?? []);
      for (const key of [...actualKeys].sort()) {
        if (!truthKeys.has(key)) {
          divergences.push({ device, key, kind: 'index_only' });
        }
      }
      for (const key of [...truthKeys].sort()) {
        if (!actualKeys.has(key)) {
          divergences.push({ device, key, kind: 'replay_only' });
        }
      }
    }
    return divergences;
  }
}

function applyToState(state, record) {
  const ck = compoundKey(record.device, record.key);
  if (record.op === 'del') {
    state.delete(ck);
  } else {
    state.set(ck, record.newValue);
  }
}

function deriveIndex(state) {
  const index = new Map();
  for (const ck of state.keys()) {
    const [device, key] = splitCompoundKey(ck);
    if (!index.has(device)) index.set(device, new Set());
    index.get(device).add(key);
  }
  return index;
}

function indexToJson(index) {
  const out = {};
  for (const device of [...index.keys()].sort()) {
    if (index.get(device).size > 0) out[device] = [...index.get(device)].sort();
  }
  return out;
}

function indexFromJson(json) {
  const index = new Map();
  for (const [device, keys] of Object.entries(json)) {
    index.set(device, new Set(keys));
  }
  return index;
}

function stateToJson(state) {
  const out = {};
  for (const ck of [...state.keys()].sort()) {
    const [device, key] = splitCompoundKey(ck);
    if (!out[device]) out[device] = {};
    out[device][key] = state.get(ck);
  }
  return out;
}

function stateFromJson(json) {
  const state = new Map();
  for (const [device, entries] of Object.entries(json)) {
    for (const [key, value] of Object.entries(entries)) {
      state.set(compoundKey(device, key), value);
    }
  }
  return state;
}

export { stateToJson, stateFromJson, deriveIndex, indexToJson, WalError };

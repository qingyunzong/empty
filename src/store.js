import fs from 'node:fs';
import path from 'node:path';
import { encodeRecord, scanWalBuffer, scanWalStrict } from './wal.js';
import { WalError, InjectedCrashError } from './errors.js';

const WAL_FILE = 'wal.log';
const INDEX_FILE = 'index.json';
const CHECKPOINT_DIR = 'checkpoints';

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

export function buildIndex(state) {
  const index = {};
  for (const [key, entry] of state) {
    (index[entry.deviceId] ??= []).push(key);
  }
  for (const deviceId of Object.keys(index)) index[deviceId].sort();
  return index;
}

export class Store {
  #dir;
  #fd;
  #state = new Map(); // key -> {value, deviceId}
  #lastTxn = 0;
  #recovery = null;
  #corruptOffset = null;

  // recover=true (write path: apply/checkpoint) truncates a torn tail so the
  // log is appendable again. recover=false (read path: replay/audit) leaves
  // the file untouched; readers tolerate a torn tail only when their target
  // txn precedes it, otherwise they fail with CHECKSUM_MISMATCH + offset.
  static open(dir, { recover = false } = {}) {
    const store = new Store();
    store.#dir = dir;
    fs.mkdirSync(path.join(dir, CHECKPOINT_DIR), { recursive: true });
    store.#scan(recover);
    store.#fd = fs.openSync(path.join(dir, WAL_FILE), 'a');
    return store;
  }

  #scan(recover) {
    const walPath = path.join(this.#dir, WAL_FILE);
    if (!fs.existsSync(walPath)) return;
    const buf = fs.readFileSync(walPath);
    const { records, corruptOffset, reason } = scanWalBuffer(buf);
    if (corruptOffset !== null) {
      if (recover) {
        fs.truncateSync(walPath, corruptOffset);
        this.#recovery = {
          truncatedAt: corruptOffset,
          droppedBytes: buf.length - corruptOffset,
          reason,
        };
      } else {
        this.#corruptOffset = corruptOffset;
      }
    }
    for (const { record } of records) this.#applyRecord(record, this.#state);
    this.#lastTxn = records.length > 0 ? records[records.length - 1].record.txn : 0;
  }

  get recovery() {
    return this.#recovery;
  }

  get corruptOffset() {
    return this.#corruptOffset;
  }

  get lastTxn() {
    return this.#lastTxn;
  }

  get state() {
    return this.#state;
  }

  #walPath() {
    return path.join(this.#dir, WAL_FILE);
  }

  #indexPath() {
    return path.join(this.#dir, INDEX_FILE);
  }

  #applyRecord(record, state) {
    if (record.op === 'set') {
      state.set(record.key, { value: record.newValue, deviceId: record.deviceId });
    } else if (record.op === 'del') {
      state.delete(record.key);
    } else {
      throw new WalError('BAD_RECORD', `unknown op ${JSON.stringify(record.op)} at txn ${record.txn}`);
    }
  }

  // Falsifiability: each record's logged oldValue must match replayed state.
  #verifyOldValue(record, state) {
    const current = state.get(record.key);
    const currentValue = current === undefined ? null : current.value;
    if (!deepEqual(currentValue, record.oldValue)) {
      throw new WalError(
        'OLD_VALUE_MISMATCH',
        `txn ${record.txn}: logged oldValue does not match replayed state for key ${JSON.stringify(record.key)}`,
        { txn: record.txn, key: record.key },
      );
    }
  }

  apply({ key, deviceId = null, value = null, op = 'set' }, { inject = null } = {}) {
    if (this.#corruptOffset !== null) {
      throw new WalError(
        'CHECKSUM_MISMATCH',
        `WAL corruption at byte offset ${this.#corruptOffset}; reopen with {recover:true} to truncate`,
        { offset: this.#corruptOffset },
      );
    }
    if (op !== 'set' && op !== 'del') throw new WalError('USAGE', `unknown op ${op}`);
    if (op === 'set' && (deviceId === null || deviceId === undefined)) {
      throw new WalError('USAGE', 'set requires deviceId');
    }
    const txn = this.#lastTxn + 1;
    const existing = this.#state.get(key);
    const record = {
      txn,
      op,
      key,
      deviceId: op === 'set' ? deviceId : (existing?.deviceId ?? deviceId),
      oldValue: existing === undefined ? null : existing.value,
      newValue: op === 'set' ? value : null,
    };
    const bytes = encodeRecord(record);
    fs.writeSync(this.#fd, bytes);
    if (inject === 'after-write') throw new InjectedCrashError('after-write', txn);
    fs.fsyncSync(this.#fd);
    if (inject === 'after-fsync') throw new InjectedCrashError('after-fsync', txn);
    this.#applyRecord(record, this.#state);
    this.#lastTxn = txn;
    this.#persistIndex();
    return record;
  }

  #persistIndex() {
    atomicWriteJson(this.#indexPath(), buildIndex(this.#state));
  }

  readIndex() {
    if (!fs.existsSync(this.#indexPath())) return {};
    return JSON.parse(fs.readFileSync(this.#indexPath(), 'utf8'));
  }

  // Replay state at txn `to`. Uses the newest checkpoint <= to, then scans the
  // WAL forward. Read-only: never mutates the log.
  replay(to) {
    if (!Number.isInteger(to) || to < 0) {
      throw new WalError('USAGE', `replay target must be a non-negative integer, got ${to}`);
    }
    const walBuf = fs.existsSync(this.#walPath()) ? fs.readFileSync(this.#walPath()) : Buffer.alloc(0);
    const { records, corruptOffset, reason } = scanWalBuffer(walBuf);
    const maxTxn = records.length > 0 ? records[records.length - 1].record.txn : 0;
    if (to > maxTxn) {
      if (corruptOffset !== null) {
        throw new WalError(
          'CHECKSUM_MISMATCH',
          `WAL corruption (${reason}) at byte offset ${corruptOffset}; cannot reach txn ${to}`,
          { offset: corruptOffset, reason },
        );
      }
      throw new WalError('NO_SUCH_TXN', `txn ${to} does not exist (last txn is ${maxTxn})`, {
        requested: to,
        lastTxn: maxTxn,
      });
    }
    const checkpoint = this.#loadBestCheckpoint(to);
    const state = checkpoint ? this.#stateFromCheckpoint(checkpoint) : new Map();
    const fromTxn = checkpoint ? checkpoint.txn : 0;
    for (const { record } of records) {
      if (record.txn <= fromTxn) continue;
      if (record.txn > to) break;
      this.#verifyOldValue(record, state);
      this.#applyRecord(record, state);
    }
    return state;
  }

  #checkpointPath(txn) {
    return path.join(this.#dir, CHECKPOINT_DIR, `${txn}.json`);
  }

  #listCheckpoints() {
    const dir = path.join(this.#dir, CHECKPOINT_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);
  }

  #loadBestCheckpoint(to) {
    const candidates = this.#listCheckpoints().filter((txn) => txn <= to);
    if (candidates.length === 0) return null;
    const txn = candidates[candidates.length - 1];
    return JSON.parse(fs.readFileSync(this.#checkpointPath(txn), 'utf8'));
  }

  #stateFromCheckpoint(checkpoint) {
    return new Map(checkpoint.state.map(([key, entry]) => [key, entry]));
  }

  checkpoint() {
    if (this.#corruptOffset !== null) {
      throw new WalError(
        'CHECKSUM_MISMATCH',
        `WAL corruption at byte offset ${this.#corruptOffset}; reopen with {recover:true} to truncate`,
        { offset: this.#corruptOffset },
      );
    }
    const snapshot = {
      txn: this.#lastTxn,
      state: [...this.#state.entries()],
    };
    atomicWriteJson(this.#checkpointPath(this.#lastTxn), snapshot);
    return snapshot;
  }

  // Independent verification: full replay from genesis (ignores checkpoints
  // and the live path), rebuilds the expected index, diffs against index.json.
  audit() {
    const walBuf = fs.existsSync(this.#walPath()) ? fs.readFileSync(this.#walPath()) : Buffer.alloc(0);
    const records = scanWalStrict(walBuf).map((e) => e.record);
    const state = new Map();
    for (const record of records) {
      this.#verifyOldValue(record, state);
      this.#applyRecord(record, state);
    }
    const expected = buildIndex(state);
    const actual = this.readIndex();
    const divergences = diffIndexes(expected, actual);
    return {
      ok: divergences.length === 0,
      lastTxn: records.length > 0 ? records[records.length - 1].txn : 0,
      expected,
      actual,
      divergences,
    };
  }

  close() {
    if (this.#fd !== undefined) fs.closeSync(this.#fd);
    this.#fd = undefined;
  }
}

export function diffIndexes(expected, actual) {
  const divergences = [];
  const devices = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const deviceId of [...devices].sort()) {
    const exp = new Set(expected[deviceId] ?? []);
    const act = new Set(actual[deviceId] ?? []);
    for (const key of [...exp].sort()) {
      if (!act.has(key)) divergences.push({ deviceId, key, kind: 'missing-in-index' });
    }
    for (const key of [...act].sort()) {
      if (!exp.has(key)) divergences.push({ deviceId, key, kind: 'stale-in-index' });
    }
  }
  return divergences;
}

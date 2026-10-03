'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { crc32 } = require('./crc32');
const { WalWriter, replayWal } = require('./wal');

const WAL_FILE = 'store.wal';

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function notFound(key) {
  return new StoreError('NOT_FOUND', `key not found: ${JSON.stringify(key)}`);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, WAL_FILE);
    // key -> array of { version, value } sorted by version; value === null means deleted
    this.versions = new Map();
    // key -> version of the last committed write (for conflict detection)
    this.keyLastWriter = new Map();
    this.currentVersion = 0;
    this.nextTxnId = 1;
    this.wal = new WalWriter(this.walPath);
  }

  static init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const walPath = path.join(dir, WAL_FILE);
    if (!fs.existsSync(walPath)) {
      fs.writeFileSync(walPath, Buffer.alloc(0));
    }
    return dir;
  }

  static open(dir) {
    const store = new Store(dir);
    store._recover();
    store.wal.open();
    return store;
  }

  _recover() {
    if (!fs.existsSync(this.walPath)) {
      Store.init(this.dir);
    }
    const { records, stopOffset, fileSize } = replayWal(this.walPath);
    if (stopOffset < fileSize) {
      // Torn/partial tail record from a crash: truncate and continue.
      fs.truncateSync(this.walPath, stopOffset);
    }

    const pending = new Map(); // txnId -> write records seen so far
    let maxTxnId = 0;
    for (const rec of records) {
      if (typeof rec.txn === 'number' && rec.txn > maxTxnId) maxTxnId = rec.txn;
      if (rec.t === 'put' || rec.t === 'del') {
        if (!pending.has(rec.txn)) pending.set(rec.txn, []);
        pending.get(rec.txn).push(rec);
      } else if (rec.t === 'commit') {
        const writes = pending.get(rec.txn) || [];
        if (checksumWrites(writes) === rec.checksum && typeof rec.version === 'number') {
          this._applyCommitted(writes, rec.version);
        }
        // Bad checksum: commit record is corrupt -> transaction stays invisible.
        pending.delete(rec.txn);
      } else if (rec.t === 'abort') {
        pending.delete(rec.txn);
      }
    }
    // Writes left in `pending` have no commit record (crashed mid-commit):
    // they are simply never applied.
    this.nextTxnId = maxTxnId + 1;
  }

  _applyCommitted(writes, version) {
    for (const w of writes) {
      this._applyWrite(w.key, version, w.t === 'put' ? w.value : null);
    }
    if (version > this.currentVersion) this.currentVersion = version;
  }

  _applyWrite(key, version, value) {
    let list = this.versions.get(key);
    if (!list) {
      list = [];
      this.versions.set(key, list);
    }
    list.push({ version, value });
    this.keyLastWriter.set(key, version);
  }

  // Latest committed value for `key` visible at version `at`.
  // Returns { found, value }.
  _visibleAt(key, at) {
    const list = this.versions.get(key);
    if (!list) return { found: false, value: null };
    // Linear scan from the end; lists are short in practice.
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].version <= at) {
        return list[i].value === null
          ? { found: false, value: null }
          : { found: true, value: list[i].value };
      }
    }
    return { found: false, value: null };
  }

  get(key, opts = {}) {
    const at = opts.at === undefined ? this.currentVersion : opts.at;
    const r = this._visibleAt(key, at);
    if (!r.found) throw notFound(key);
    return r.value;
  }

  has(key, opts = {}) {
    const at = opts.at === undefined ? this.currentVersion : opts.at;
    return this._visibleAt(key, at).found;
  }

  // Returns sorted array of [key, value] visible at version `at`.
  scan(opts = {}) {
    const at = opts.at === undefined ? this.currentVersion : opts.at;
    const prefix = opts.prefix;
    const out = [];
    for (const key of this.versions.keys()) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue;
      const r = this._visibleAt(key, at);
      if (r.found) out.push([key, r.value]);
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return out;
  }

  // Full version history of a key: [{ version, value }] with value === null
  // for deletions. Throws NOT_FOUND if the key was never written.
  history(key) {
    const list = this.versions.get(key);
    if (!list || list.length === 0) throw notFound(key);
    return list.map((e) => ({ version: e.version, value: e.value }));
  }

  begin() {
    return new Transaction(this);
  }

  _commit(txn) {
    if (txn.writeSet.size === 0) {
      return { version: txn.snapshotVersion };
    }
    // Snapshot isolation, first-committer-wins: abort if any key in our write
    // set was committed by another transaction after our snapshot was taken.
    for (const key of txn.writeSet.keys()) {
      const last = this.keyLastWriter.get(key) || 0;
      if (last > txn.snapshotVersion) {
        throw new StoreError('CONFLICT', `write conflict on key ${JSON.stringify(key)}`);
      }
    }

    const version = this.currentVersion + 1;
    const writes = [];
    for (const [key, op] of txn.writeSet) {
      if (op.type === 'put') {
        writes.push({ t: 'put', txn: txn.id, key, value: op.value });
      } else {
        writes.push({ t: 'del', txn: txn.id, key });
      }
    }

    // Phase 1: flush all write records.
    this.wal.append(writes);
    this.wal.fsync();

    // Fault-injection hook for crash testing: die after the data records are
    // durable but before the commit marker is written.
    if (process.env.OBS_STORE_FAULT === 'after-data-fsync') {
      process.exit(77);
    }

    // Phase 2: the commit record (with checksum over the write payloads) is
    // the atomic commit point.
    this.wal.append([{ t: 'commit', txn: txn.id, version, checksum: checksumWrites(writes) }]);
    this.wal.fsync();

    for (const w of writes) {
      this._applyWrite(w.key, version, w.t === 'put' ? w.value : null);
    }
    this.currentVersion = version;
    return { version };
  }

  _abort(txn) {
    this.wal.append([{ t: 'abort', txn: txn.id }]);
    this.wal.fsync();
  }

  close() {
    this.wal.close();
  }
}

function checksumWrites(writes) {
  let sum = 0;
  for (const w of writes) {
    sum = crc32(Buffer.from(JSON.stringify(w), 'utf8'), sum);
  }
  return sum >>> 0;
}

class Transaction {
  constructor(store) {
    this.store = store;
    this.id = store.nextTxnId++;
    this.snapshotVersion = store.currentVersion;
    this.writeSet = new Map(); // key -> { type: 'put'|'del', value? }
    this.state = 'active';
  }

  _checkActive() {
    if (this.state !== 'active') {
      throw new StoreError('INVALID', `transaction is ${this.state}`);
    }
  }

  put(key, value) {
    this._checkActive();
    validateKey(key);
    if (typeof value !== 'string') {
      throw new StoreError('INVALID', 'value must be a string');
    }
    this.writeSet.set(key, { type: 'put', value });
  }

  delete(key) {
    this._checkActive();
    validateKey(key);
    this.writeSet.set(key, { type: 'del' });
  }

  // Read-your-own-writes on top of the start-of-transaction snapshot.
  get(key) {
    this._checkActive();
    const pending = this.writeSet.get(key);
    if (pending) {
      if (pending.type === 'del') throw notFound(key);
      return pending.value;
    }
    return this.store.get(key, { at: this.snapshotVersion });
  }

  commit() {
    this._checkActive();
    const result = this.store._commit(this);
    this.state = 'committed';
    return result;
  }

  abort() {
    this._checkActive();
    this.store._abort(this);
    this.state = 'aborted';
  }
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StoreError('INVALID', 'key must be a non-empty string');
  }
}

module.exports = { Store, StoreError };

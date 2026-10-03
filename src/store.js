'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WalWriter, recover } = require('./wal');
const { StoreError, NOT_FOUND, INVALID, CONFLICT } = require('./errors');

const WAL_FILE = 'store.wal';

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StoreError(INVALID, `invalid key: ${String(key)}`);
  }
}

function validateValue(value) {
  if (typeof value !== 'string') {
    throw new StoreError(INVALID, `invalid value for key (must be string)`);
  }
}

class Transaction {
  constructor(store, snapshotVersion) {
    this.store = store;
    this.snapshotVersion = snapshotVersion;
    this.writes = new Map(); // key -> value string, or null for delete
    this.active = true;
  }

  put(key, value) {
    this.#assertActive();
    validateKey(key);
    validateValue(value);
    this.writes.set(key, value);
  }

  delete(key) {
    this.#assertActive();
    validateKey(key);
    this.writes.set(key, null);
  }

  get(key) {
    this.#assertActive();
    validateKey(key);
    if (this.writes.has(key)) {
      const own = this.writes.get(key);
      if (own === null) throw new StoreError(NOT_FOUND, `key not found: ${key}`);
      return own;
    }
    return this.store.get(key, this.snapshotVersion);
  }

  commit() {
    this.#assertActive();
    this.active = false;
    return this.store.commit(this);
  }

  abort() {
    this.#assertActive();
    this.active = false;
    this.writes.clear();
  }

  #assertActive() {
    if (!this.active) {
      throw new StoreError(INVALID, 'transaction is no longer active');
    }
  }
}

class Store {
  static init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const walPath = path.join(dir, WAL_FILE);
    if (!fs.existsSync(walPath)) {
      fs.writeFileSync(walPath, Buffer.alloc(0));
    }
  }

  constructor(dir, opts = {}) {
    this.dir = dir;
    this.walPath = path.join(dir, WAL_FILE);
    if (!fs.existsSync(this.walPath)) {
      throw new StoreError(INVALID, `store not initialized at ${dir} (run init first)`);
    }
    this.hooks = opts.hooks || {};
    // index: key -> array of { version, value } sorted by version ascending; value null = tombstone
    this.index = new Map();
    this.currentVersion = 0;
    this.#recover();
    this.wal = new WalWriter(this.walPath);
    if (this.truncatedTo !== this.wal.offset) {
      this.wal.truncate(this.truncatedTo);
    }
  }

  #recover() {
    const { records, validEnd } = recover(this.walPath);
    this.truncatedTo = validEnd;
    const pending = new Map(); // txnId -> entries
    for (const record of records) {
      if (record.t === 'data') {
        pending.set(record.txn, record.entries);
      } else if (record.t === 'commit') {
        const entries = pending.get(record.txn);
        pending.delete(record.txn);
        if (!entries) continue;
        for (const entry of entries) {
          this.#applyCommitted(entry.k, entry.v, record.ver);
        }
        if (record.ver > this.currentVersion) this.currentVersion = record.ver;
      }
    }
    // data records without a commit marker are discarded (uncommitted transaction)
  }

  #applyCommitted(key, value, version) {
    let versions = this.index.get(key);
    if (!versions) {
      versions = [];
      this.index.set(key, versions);
    }
    versions.push({ version, value });
  }

  begin() {
    return new Transaction(this, this.currentVersion);
  }

  commit(txn) {
    if (txn.writes.size === 0) {
      return { version: this.currentVersion };
    }
    // Conflict check: any key in our write set committed after our snapshot began.
    for (const key of txn.writes.keys()) {
      const versions = this.index.get(key);
      if (versions && versions[versions.length - 1].version > txn.snapshotVersion) {
        throw new StoreError(CONFLICT, `write conflict on key: ${key}`);
      }
    }
    const version = this.currentVersion + 1;
    const txnId = `${process.pid}:${Date.now()}:${version}`;
    const entries = [...txn.writes.entries()].map(([k, v]) => ({ k, v }));
    this.wal.append({ t: 'data', txn: txnId, entries });
    this.wal.fsync();
    // Fault injection point: crash after data is durable but before the commit marker.
    if (process.env.KVSTORE_FAULT === 'afterDataFsync') {
      process.exit(42);
    }
    if (this.hooks.afterDataFsync) {
      this.hooks.afterDataFsync();
    }
    this.wal.append({ t: 'commit', txn: txnId, ver: version });
    this.wal.fsync();
    for (const entry of entries) {
      this.#applyCommitted(entry.k, entry.v, version);
    }
    this.currentVersion = version;
    return { version };
  }

  #visibleAt(key, version) {
    const versions = this.index.get(key);
    if (!versions) return undefined;
    let result;
    for (const entry of versions) {
      if (entry.version > version) break;
      result = entry;
    }
    return result;
  }

  get(key, version = this.currentVersion) {
    validateKey(key);
    this.#validateVersion(version);
    const entry = this.#visibleAt(key, version);
    if (!entry || entry.value === null) {
      throw new StoreError(NOT_FOUND, `key not found: ${key}`);
    }
    return entry.value;
  }

  scan(version = this.currentVersion) {
    this.#validateVersion(version);
    const out = [];
    for (const key of this.index.keys()) {
      const entry = this.#visibleAt(key, version);
      if (entry && entry.value !== null) {
        out.push([key, entry.value]);
      }
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return out;
  }

  history(key) {
    validateKey(key);
    const versions = this.index.get(key);
    if (!versions || versions.length === 0) {
      throw new StoreError(NOT_FOUND, `key not found: ${key}`);
    }
    return versions.map((entry) => ({ version: entry.version, value: entry.value }));
  }

  #validateVersion(version) {
    if (!Number.isInteger(version) || version < 0 || version > this.currentVersion) {
      throw new StoreError(INVALID, `invalid version: ${String(version)}`);
    }
  }

  close() {
    if (this.wal) {
      this.wal.close();
      this.wal = null;
    }
  }
}

module.exports = { Store, Transaction, WAL_FILE };

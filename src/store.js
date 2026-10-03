'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class StoreError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StoreError';
    this.code = code;
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StoreError('E_BAD_REQUEST', 'key must be a non-empty string');
  }
}

function assertValue(value) {
  if (value === undefined) {
    throw new StoreError('E_BAD_REQUEST', 'value must be defined');
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new StoreError('E_BAD_REQUEST', 'value must be JSON-serializable');
  }
}

// Append-only MVCC store. Each commit creates one immutable file
// versions/NNNNNN.json holding {version, writes}. History is never
// overwritten; a snapshot read at version V only sees writes with
// version <= V.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.versionsDir = path.join(dir, 'versions');
    fs.mkdirSync(this.versionsDir, { recursive: true });
    this._cache = new Map();
  }

  _versionFile(version) {
    return path.join(this.versionsDir, String(version).padStart(6, '0') + '.json');
  }

  async currentVersion() {
    const entries = await fsp.readdir(this.versionsDir);
    let max = 0;
    for (const entry of entries) {
      const m = /^(\d+)\.json$/.exec(entry);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  async _loadVersion(version) {
    if (this._cache.has(version)) return this._cache.get(version);
    let raw;
    try {
      raw = await fsp.readFile(this._versionFile(version), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const record = JSON.parse(raw);
    this._cache.set(version, record);
    return record;
  }

  // Latest value of `key` visible at `version`, or undefined.
  async getAt(key, version) {
    assertKey(key);
    for (let v = version; v >= 1; v--) {
      const record = await this._loadVersion(v);
      if (record && Object.prototype.hasOwnProperty.call(record.writes, key)) {
        return record.writes[key];
      }
    }
    return undefined;
  }

  // Full materialized state visible at `version`.
  async stateAt(version) {
    const state = {};
    for (let v = 1; v <= version; v++) {
      const record = await this._loadVersion(v);
      if (record) Object.assign(state, record.writes);
    }
    return state;
  }

  async begin() {
    return new Tx(this, await this.currentVersion());
  }

  // First-committer-wins commit. The new version file is published
  // atomically via hard-link; on a lost race the conflict check is
  // re-run against the newer versions before retrying.
  async _commit(tx) {
    const writes = tx._writes;
    if (writes.size === 0) {
      return { version: await this.currentVersion() };
    }
    for (;;) {
      const current = await this.currentVersion();
      for (let v = tx.snapshotVersion + 1; v <= current; v++) {
        const record = await this._loadVersion(v);
        if (!record) continue;
        for (const key of writes.keys()) {
          if (Object.prototype.hasOwnProperty.call(record.writes, key)) {
            throw new StoreError(
              'E_CONFLICT',
              `key "${key}" was committed at version ${v}, after snapshot ${tx.snapshotVersion}`
            );
          }
        }
      }
      const next = current + 1;
      const record = { version: next, writes: Object.fromEntries(writes) };
      const tmp = path.join(
        this.versionsDir,
        `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
      );
      await fsp.writeFile(tmp, JSON.stringify(record));
      try {
        await fsp.link(tmp, this._versionFile(next));
      } catch (err) {
        await fsp.unlink(tmp).catch(() => {});
        if (err.code === 'EEXIST') continue;
        throw err;
      }
      await fsp.unlink(tmp).catch(() => {});
      this._cache.set(next, record);
      return { version: next };
    }
  }
}

class Tx {
  constructor(store, snapshotVersion) {
    this.store = store;
    this.snapshotVersion = snapshotVersion;
    this._writes = new Map();
    this._done = false;
  }

  _assertActive() {
    if (this._done) throw new StoreError('E_TX_CLOSED', 'transaction already committed');
  }

  // Reads see own writes first, otherwise only the snapshot.
  async get(key) {
    this._assertActive();
    assertKey(key);
    if (this._writes.has(key)) return this._writes.get(key);
    return this.store.getAt(key, this.snapshotVersion);
  }

  put(key, value) {
    this._assertActive();
    assertKey(key);
    assertValue(value);
    this._writes.set(key, value);
  }

  async commit() {
    this._assertActive();
    this._done = true;
    return this.store._commit(this);
  }
}

module.exports = { Store, Tx, StoreError };

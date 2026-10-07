import fs from 'node:fs';
import path from 'node:path';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// A value participates in the secondary unique index only when it is an
// object whose workcenter and timeSlot are both strings. Zero-length work
// orders ("") and other shapes stay out of the index. The index key is a
// JSON-encoded pair, so any string content is unambiguous.
export function indexKeyOf(value) {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.workcenter === 'string' &&
    typeof value.timeSlot === 'string'
  ) {
    return JSON.stringify([value.workcenter, value.timeSlot]);
  }
  return null;
}

function isJsonValue(value) {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

export class Store {
  // In-memory store (no persistence). Use Store.open(dir) for a durable one.
  constructor() {
    // Version chain: version 0 is the empty genesis version.
    this.versions = new Map([[0, { id: 0, parent: null, writes: {} }]]);
    this.latest = 0;
    this.nextVersion = 1;
    this.nextTx = 1;
    this.txs = new Map();
    this._dataCache = new Map([[0, {}]]);
    this.logFile = null;
  }

  // Open (or create) a durable store rooted at dir. Committed versions are
  // appended to <dir>/versions.jsonl and replayed on open.
  static open(dir) {
    const store = new Store();
    fs.mkdirSync(dir, { recursive: true });
    store.logFile = path.join(dir, 'versions.jsonl');
    if (fs.existsSync(store.logFile)) {
      const lines = fs.readFileSync(store.logFile, 'utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        const rec = JSON.parse(line);
        store.versions.set(rec.id, { id: rec.id, parent: rec.parent, writes: rec.writes });
        store.latest = rec.id;
        store.nextVersion = rec.id + 1;
      }
    }
    return store;
  }

  // Materialize the committed key/value view at a version by walking the
  // version chain back to the nearest cached snapshot.
  dataAt(versionId) {
    if (this._dataCache.has(versionId)) return this._dataCache.get(versionId);
    const chain = [];
    let cursor = versionId;
    while (cursor !== null && !this._dataCache.has(cursor)) {
      chain.push(cursor);
      cursor = this.versions.get(cursor).parent;
    }
    let data = cursor === null ? {} : this._dataCache.get(cursor);
    for (let i = chain.length - 1; i >= 0; i--) {
      const version = this.versions.get(chain[i]);
      data = { ...data, ...version.writes };
      this._dataCache.set(chain[i], data);
    }
    return data;
  }

  // Snapshot is fixed here: the tx reads the committed view at baseVersion.
  begin() {
    const id = 'tx' + this.nextTx++;
    this.txs.set(id, { id, base: this.latest, writes: new Map(), done: false });
    return id;
  }

  baseVersionOf(txId) {
    return this._liveTx(txId).base;
  }

  _liveTx(txId) {
    const tx = this.txs.get(txId);
    if (!tx || tx.done) {
      throw new StoreError('E_USAGE', `unknown or finished transaction: ${String(txId)}`);
    }
    return tx;
  }

  // Read-your-own-writes over the begin-time snapshot.
  get(txId, key) {
    const tx = this._liveTx(txId);
    if (typeof key !== 'string') {
      throw new StoreError('E_USAGE', 'key must be a string');
    }
    if (tx.writes.has(key)) return structuredClone(tx.writes.get(key));
    const snapshot = this.dataAt(tx.base);
    return Object.hasOwn(snapshot, key) ? structuredClone(snapshot[key]) : null;
  }

  put(txId, key, value) {
    const tx = this._liveTx(txId);
    if (typeof key !== 'string') {
      throw new StoreError('E_USAGE', 'key must be a string');
    }
    if (value === undefined || value === null || !isJsonValue(value)) {
      throw new StoreError('E_USAGE', 'value must be a non-null JSON value');
    }
    tx.writes.set(key, structuredClone(value));
  }

  commit(txId) {
    const tx = this._liveTx(txId);

    // 1. Snapshot conflict: refuse to overwrite any key that a newer
    //    committed version (after this tx's base) has modified.
    let cursor = this.latest;
    while (cursor !== tx.base) {
      const version = this.versions.get(cursor);
      for (const key of Object.keys(version.writes)) {
        if (tx.writes.has(key)) {
          throw new StoreError(
            'E_SNAPSHOT',
            `key ${JSON.stringify(key)} was modified by committed version ${version.id} after this transaction began`
          );
        }
      }
      cursor = version.parent;
    }

    // 2. Unique secondary index (workcenter, timeSlot), checked atomically
    //    against the committed key space plus this tx's writes.
    const committed = this.dataAt(this.latest);
    const index = new Map(); // indexKey -> owning work-order key
    for (const [key, value] of Object.entries(committed)) {
      const ik = indexKeyOf(value);
      if (ik !== null) index.set(ik, key);
    }
    // First pass: evict index entries of keys this tx overwrites.
    for (const key of tx.writes.keys()) {
      if (Object.hasOwn(committed, key)) {
        const oldIk = indexKeyOf(committed[key]);
        if (oldIk !== null && index.get(oldIk) === key) index.delete(oldIk);
      }
    }
    // Second pass: insert this tx's indexable values.
    for (const [key, value] of tx.writes) {
      const ik = indexKeyOf(value);
      if (ik === null) continue;
      const owner = index.get(ik);
      if (owner !== undefined && owner !== key) {
        throw new StoreError(
          'E_UNIQUE',
          `workcenter/timeSlot already occupied by committed work order ${JSON.stringify(owner)}`
        );
      }
      index.set(ik, key);
    }

    // 3. Merge: append a new version to the chain and persist it.
    const id = this.nextVersion++;
    const writes = Object.fromEntries(tx.writes);
    this.versions.set(id, { id, parent: this.latest, writes });
    this.latest = id;
    if (this.logFile) {
      fs.appendFileSync(this.logFile, JSON.stringify({ id, parent: this.versions.get(id).parent, writes }) + '\n');
    }
    tx.done = true;
    return id;
  }

  abort(txId) {
    const tx = this._liveTx(txId);
    tx.done = true;
  }
}

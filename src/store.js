import fs from 'node:fs';
import path from 'node:path';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// A committed value participates in the unique secondary index when it is a
// plain object with string `workcenter` and `timeSlot` fields (a work order).
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

function assertKey(key) {
  if (typeof key !== 'string') {
    throw new StoreError('E_USAGE', `key must be a string, got ${typeof key}`);
  }
}

function assertValue(value) {
  if (value === null) return; // null deletes the key
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new StoreError('E_USAGE', 'value must be JSON-serializable');
  }
  if (json === undefined) {
    throw new StoreError('E_USAGE', 'value must be JSON-serializable');
  }
}

export class Transaction {
  constructor(store, snapshot) {
    this.store = store;
    this.snapshot = snapshot;
    this.writes = new Map();
    this.active = true;
  }

  #checkActive() {
    if (!this.active) {
      throw new StoreError('E_TX_STATE', 'transaction is no longer active');
    }
  }

  // Returns the visible value, or undefined when the key is absent.
  get(key) {
    this.#checkActive();
    assertKey(key);
    if (this.writes.has(key)) {
      const value = this.writes.get(key);
      return value === null ? undefined : structuredClone(value);
    }
    return this.store.readAt(key, this.snapshot);
  }

  // `value` may be any JSON-serializable value; null deletes the key.
  put(key, value) {
    this.#checkActive();
    assertKey(key);
    assertValue(value);
    this.writes.set(key, value === null ? null : structuredClone(value));
  }

  commit() {
    this.#checkActive();
    const version = this.store.commit(this);
    this.active = false;
    return version;
  }

  abort() {
    this.#checkActive();
    this.writes.clear();
    this.active = false;
  }
}

export class Store {
  static open(dir) {
    return new Store(dir);
  }

  // `dir` is optional; when given, commits are appended to `<dir>/log.jsonl`
  // and replayed on open. Without `dir` the store is purely in-memory.
  constructor(dir = null) {
    this.dir = dir;
    this.logFile = dir ? path.join(dir, 'log.jsonl') : null;
    this.version = 0;
    this.chains = new Map(); // key -> [{ version, value }] ascending by version; value null = tombstone
    this.index = new Map(); // indexKey -> key (committed unique index)
    this.keyIndex = new Map(); // key -> indexKey (committed)
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.#load();
    }
  }

  #load() {
    if (!fs.existsSync(this.logFile)) return;
    const lines = fs.readFileSync(this.logFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.version !== this.version + 1) {
        throw new StoreError(
          'E_CORRUPT',
          `log version gap: expected ${this.version + 1}, got ${record.version}`,
        );
      }
      this.#apply(record.writes);
    }
  }

  #apply(writes) {
    this.version += 1;
    for (const [key, value] of writes) {
      let chain = this.chains.get(key);
      if (!chain) {
        chain = [];
        this.chains.set(key, chain);
      }
      chain.push({ version: this.version, value });
      const oldIndexKey = this.keyIndex.get(key);
      if (oldIndexKey !== undefined) {
        this.index.delete(oldIndexKey);
        this.keyIndex.delete(key);
      }
      const indexKey = indexKeyOf(value);
      if (indexKey !== null) {
        this.index.set(indexKey, key);
        this.keyIndex.set(key, indexKey);
      }
    }
  }

  readAt(key, snapshot) {
    const chain = this.chains.get(key);
    if (!chain) return undefined;
    let lo = 0;
    let hi = chain.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chain[mid].version <= snapshot) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return undefined;
    const value = chain[found].value;
    return value === null ? undefined : structuredClone(value);
  }

  begin() {
    return new Transaction(this, this.version);
  }

  commit(tx) {
    // Write-write conflict: a key written by this transaction was modified
    // by a commit newer than the transaction's snapshot.
    for (const key of tx.writes.keys()) {
      const chain = this.chains.get(key);
      if (chain && chain[chain.length - 1].version > tx.snapshot) {
        throw new StoreError(
          'E_SNAPSHOT',
          `key ${JSON.stringify(key)} was modified after snapshot version ${tx.snapshot}`,
        );
      }
    }

    // Unique index check, atomic over this commit's key space: the committed
    // index plus exactly the keys this commit touches.
    const proposed = new Map(); // indexKey -> key, within this commit
    for (const [key, value] of tx.writes) {
      const indexKey = indexKeyOf(value);
      if (indexKey === null) continue;
      if (proposed.has(indexKey)) {
        throw new StoreError(
          'E_UNIQUE',
          `unique index (workcenter, timeSlot) ${indexKey} written twice in one commit`,
        );
      }
      const holder = this.index.get(indexKey);
      if (holder !== undefined && holder !== key && !tx.writes.has(holder)) {
        throw new StoreError(
          'E_UNIQUE',
          `unique index (workcenter, timeSlot) ${indexKey} already held by key ${JSON.stringify(holder)}`,
        );
      }
      proposed.set(indexKey, key);
    }

    const writes = [...tx.writes.entries()];
    if (writes.length === 0) {
      return this.version;
    }
    if (this.logFile) {
      fs.appendFileSync(
        this.logFile,
        JSON.stringify({ version: this.version + 1, writes }) + '\n',
      );
    }
    this.#apply(writes);
    return this.version;
  }
}

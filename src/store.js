import fs from 'node:fs';
import path from 'node:path';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// Append-only versioned key-value store.
// Each commit appends versions/<n>.json = { key: value, ... } and bumps HEAD.
// Old versions are never overwritten, so any historical snapshot is readable.
export class Store {
  static open(dir) {
    return new Store(dir);
  }

  constructor(dir) {
    this.dir = dir;
    this.versionsDir = path.join(dir, 'versions');
    fs.mkdirSync(this.versionsDir, { recursive: true });
    this.headPath = path.join(dir, 'HEAD');
    if (!fs.existsSync(this.headPath)) {
      fs.writeFileSync(this.headPath, '0\n');
    }
    this.lockPath = path.join(dir, 'lock');
    this._writesCache = new Map();
  }

  head() {
    const raw = fs.readFileSync(this.headPath, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  }

  // Writes applied by a single committed version (immutable once committed).
  writesAt(version) {
    if (version < 1) return {};
    let w = this._writesCache.get(version);
    if (w === undefined) {
      const file = path.join(this.versionsDir, `${version}.json`);
      w = JSON.parse(fs.readFileSync(file, 'utf8'));
      this._writesCache.set(version, w);
    }
    return w;
  }

  // Latest value of `key` visible at `version`; undefined if never written.
  readAt(key, version) {
    const limit = Math.min(version, this.head());
    for (let v = limit; v >= 1; v--) {
      const w = this.writesAt(v);
      if (Object.hasOwn(w, key)) return clone(w[key]);
    }
    return undefined;
  }

  // Full merged state visible at `version`.
  stateAt(version) {
    const state = {};
    const limit = Math.min(version, this.head());
    for (let v = 1; v <= limit; v++) Object.assign(state, this.writesAt(v));
    return clone(state);
  }

  begin() {
    return new Tx(this, this.head());
  }

  _acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.mkdirSync(this.lockPath);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const st = fs.statSync(this.lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.rmdirSync(this.lockPath);
            continue;
          }
        } catch {
          // lock dir vanished between stat and rmdir; retry
          continue;
        }
        if (Date.now() > deadline) {
          throw new StoreError('E_LOCKED', 'timed out acquiring store lock');
        }
        sleepSync(2);
      }
    }
  }

  _releaseLock() {
    try {
      fs.rmdirSync(this.lockPath);
    } catch {
      // already released
    }
  }

  // First-committer-wins commit: fails with E_CONFLICT if any directly
  // written key appears in a version committed after `snapshot`.
  commitWrites(snapshot, writes) {
    this._acquireLock();
    try {
      const head = this.head();
      for (let v = snapshot + 1; v <= head; v++) {
        const w = this.writesAt(v);
        for (const key of writes.keys()) {
          if (Object.hasOwn(w, key)) {
            throw new StoreError(
              'E_CONFLICT',
              `key "${key}" was committed at version ${v}, after snapshot ${snapshot}`,
            );
          }
        }
      }
      const next = head + 1;
      const obj = {};
      for (const [k, val] of writes) obj[k] = clone(val);
      const file = path.join(this.versionsDir, `${next}.json`);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
      const headTmp = `${this.headPath}.tmp`;
      fs.writeFileSync(headTmp, `${next}\n`);
      fs.renameSync(headTmp, this.headPath);
      this._writesCache.set(next, obj);
      return next;
    } finally {
      this._releaseLock();
    }
  }
}

export class Tx {
  constructor(store, snapshot) {
    this.store = store;
    this.snapshot = snapshot;
    this.writes = new Map();
    this.done = false;
  }

  // Read-your-own-writes; otherwise read from the begin-time snapshot only.
  get(key) {
    if (this.writes.has(key)) return clone(this.writes.get(key));
    return this.store.readAt(key, this.snapshot);
  }

  put(key, value) {
    if (value === undefined) throw new StoreError('E_VALUE', 'cannot put undefined');
    this.writes.set(key, clone(value));
  }

  commit() {
    if (this.done) throw new StoreError('E_TX_DONE', 'transaction already finished');
    this.done = true;
    return this.store.commitWrites(this.snapshot, this.writes);
  }
}

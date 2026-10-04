// Naive reference implementation: "copy array + visibility rules".
// The committed state is kept as an array of full-map copies; every commit
// pushes a brand-new copied map. Reads scan nothing fancier than the snapshot
// copy taken at begin(). Used as the oracle for the enumeration test.
import { StoreError, indexKeyOf } from '../../src/store.js';

export class RefStore {
  constructor() {
    this.history = [new Map()]; // history[v] = full committed state at version v
    this.changed = [new Set()]; // changed[v] = keys written by the commit that produced version v
  }

  begin() {
    return new RefTransaction(this, this.history.length - 1);
  }

  get version() {
    return this.history.length - 1;
  }
}

class RefTransaction {
  constructor(store, snapshot) {
    this.store = store;
    this.snapshot = snapshot;
    this.writes = new Map();
    this.active = true;
  }

  #checkActive() {
    if (!this.active) throw new StoreError('E_TX_STATE', 'transaction is no longer active');
  }

  get(key) {
    this.#checkActive();
    if (this.writes.has(key)) {
      const value = this.writes.get(key);
      return value === null ? undefined : value;
    }
    const value = this.store.history[this.snapshot].get(key);
    return value === null || value === undefined ? undefined : value;
  }

  put(key, value) {
    this.#checkActive();
    this.writes.set(key, value);
  }

  commit() {
    this.#checkActive();
    const store = this.store;
    const version = (() => {
      // Snapshot conflict: any key we wrote changed since our snapshot.
      for (const key of this.writes.keys()) {
        for (let v = this.snapshot + 1; v < store.changed.length; v += 1) {
          if (store.changed[v].has(key)) {
            throw new StoreError('E_SNAPSHOT', `key ${JSON.stringify(key)} changed after snapshot`);
          }
        }
      }
      // Unique index: copy latest committed map, apply our writes, scan all
      // values for duplicate (workcenter, timeSlot) pairs.
      const merged = new Map(store.history[store.history.length - 1]);
      for (const [key, value] of this.writes) {
        if (value === null) merged.delete(key);
        else merged.set(key, value);
      }
      const seen = new Map();
      for (const [key, value] of merged) {
        const indexKey = indexKeyOf(value);
        if (indexKey === null) continue;
        if (seen.has(indexKey)) {
          throw new StoreError(
            'E_UNIQUE',
            `unique index ${indexKey} held by both ${JSON.stringify(seen.get(indexKey))} and ${JSON.stringify(key)}`,
          );
        }
        seen.set(indexKey, key);
      }
      if (this.writes.size === 0) return store.version;
      store.history.push(merged);
      store.changed.push(new Set(this.writes.keys()));
      return store.version;
    })();
    this.active = false;
    return version;
  }

  abort() {
    this.#checkActive();
    this.writes.clear();
    this.active = false;
  }
}

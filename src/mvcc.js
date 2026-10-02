'use strict';

// MVCC store with snapshot isolation.
// - Every commit gets a monotonically increasing commitSeq.
// - Each key keeps a version chain { value, commitSeq }.
// - A transaction reads the latest version with commitSeq <= its snapshotSeq.
// - Writes are buffered and applied at commit; validators registered by the
//   transaction run against the fully applied (but not yet published) state.
//   If any validator throws, every write and index update is rolled back.

let nextTxnId = 1;

class MVCCStore {
  constructor() {
    this.commitSeq = 0;
    this.data = new Map(); // key -> [{ value, commitSeq }]
    this.indexes = new Map(); // name -> { keyFn, map: Map<indexKey, Map<recordKey, value>> }
  }

  defineIndex(name, keyFn) {
    if (this.indexes.has(name)) throw new Error(`index already defined: ${name}`);
    this.indexes.set(name, { keyFn, map: new Map() });
  }

  begin() {
    return new Transaction(this, this.commitSeq, nextTxnId++);
  }

  latest(key) {
    const chain = this.data.get(key);
    if (!chain || chain.length === 0) return undefined;
    return chain[chain.length - 1].value;
  }

  indexEntries(name, indexKey) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`unknown index: ${name}`);
    const bucket = idx.map.get(indexKey);
    if (!bucket) return [];
    return [...bucket.entries()].map(([key, value]) => ({ key, value }));
  }

  commit(txn) {
    if (txn.store !== this) throw new Error('transaction belongs to another store');
    if (txn.state !== 'active') throw new Error(`transaction not active: ${txn.state}`);
    const seq = this.commitSeq + 1;
    const undo = [];
    try {
      for (const [key, value] of txn.writes) {
        let chain = this.data.get(key);
        if (!chain) {
          chain = [];
          this.data.set(key, chain);
          undo.push(() => this.data.delete(key));
        } else {
          undo.push(() => {});
        }
        const replaced = chain.length ? chain[chain.length - 1].value : undefined;
        chain.push({ value, commitSeq: seq });
        undo.push(() => chain.pop());
        for (const idx of this.indexes.values()) {
          // remove stale index entries of the replaced version
          if (replaced !== undefined) {
            for (const ik of idx.keyFn(key, replaced)) {
              const bucket = idx.map.get(ik);
              if (bucket && bucket.has(key)) {
                bucket.delete(key);
                undo.push(() => bucket.set(key, replaced));
              }
            }
          }
          for (const ik of idx.keyFn(key, value)) {
            let bucket = idx.map.get(ik);
            if (!bucket) {
              bucket = new Map();
              idx.map.set(ik, bucket);
              undo.push(() => idx.map.delete(ik));
            }
            bucket.set(key, value);
            undo.push(() => bucket.delete(key));
          }
        }
      }
      for (const validator of txn.validators) validator(this, txn);
    } catch (err) {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
      txn.state = 'aborted';
      throw err;
    }
    this.commitSeq = seq;
    txn.state = 'committed';
    txn.commitSeq = seq;
    return seq;
  }
}

class Transaction {
  constructor(store, snapshotSeq, id) {
    this.store = store;
    this.snapshotSeq = snapshotSeq;
    this.id = id;
    this.state = 'active';
    this.writes = new Map();
    this.validators = [];
    this.commitSeq = null;
  }

  get(key) {
    if (this.writes.has(key)) return this.writes.get(key);
    const chain = this.store.data.get(key);
    if (!chain) return undefined;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].commitSeq <= this.snapshotSeq) return chain[i].value;
    }
    return undefined;
  }

  // Iterate visible committed values for keys with the given prefix.
  scan(prefix) {
    const out = [];
    for (const key of this.store.data.keys()) {
      if (!key.startsWith(prefix)) continue;
      const value = this.get(key);
      if (value !== undefined) out.push({ key, value });
    }
    return out;
  }

  put(key, value) {
    if (this.state !== 'active') throw new Error(`transaction not active: ${this.state}`);
    this.writes.set(key, value);
  }

  addValidator(fn) {
    this.validators.push(fn);
  }

  commit() {
    return this.store.commit(this);
  }
}

module.exports = { MVCCStore, Transaction };

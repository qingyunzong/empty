// MVCC versioned map: every key keeps a chain of {seq, value} versions.
// Readers pick the newest version with seq <= their snapshot, so
// uncommitted data (never applied) is invisible by construction.
export class VersionedMap {
  constructor() {
    this.entries = new Map(); // key -> [{seq, value}] ascending by seq
  }

  set(key, value, seq) {
    let versions = this.entries.get(key);
    if (!versions) {
      versions = [];
      this.entries.set(key, versions);
    }
    versions.push({ seq, value });
  }

  get(key, snapshotSeq = Infinity) {
    const versions = this.entries.get(key);
    if (!versions) return undefined;
    let found;
    for (const version of versions) {
      if (version.seq <= snapshotSeq) found = version;
      else break;
    }
    return found ? found.value : undefined;
  }

  snapshot(snapshotSeq = Infinity) {
    const out = new Map();
    for (const key of this.entries.keys()) {
      const value = this.get(key, snapshotSeq);
      if (value !== undefined) out.set(key, value);
    }
    return out;
  }
}

// Committed state rebuilt from the WAL. Transactions without a commit
// record (crash point P1) are rolled back: their data records are dropped.
export class Store {
  constructor() {
    this.balances = new VersionedMap();
    this.transactions = new VersionedMap();
    this.idem = new VersionedMap(); // requestId -> first committed result
    this.intents = new Map(); // requestId -> {op, params} from begin records
    this.lastSeq = 0;
    this.beginCount = 0;
  }

  static recover(records) {
    const store = new Store();
    const pending = new Map(); // txnId -> {begin, mutations}
    for (const record of records) {
      if (record.type === 'begin') {
        store.beginCount += 1;
        pending.set(record.txnId, { begin: record, mutations: null });
        if (!store.intents.has(record.requestId)) {
          store.intents.set(record.requestId, { op: record.op, params: record.params });
        }
      } else if (record.type === 'data') {
        const tx = pending.get(record.txnId);
        if (tx) tx.mutations = record.mutations;
      } else if (record.type === 'commit') {
        const tx = pending.get(record.txnId);
        if (tx && tx.mutations) store.apply(tx.mutations, record.seq);
        pending.delete(record.txnId);
        if (record.seq > store.lastSeq) store.lastSeq = record.seq;
      }
    }
    return store;
  }

  apply(mutations, seq) {
    for (const mutation of mutations) {
      if (mutation.kind === 'setBalance') this.balances.set(mutation.account, mutation.value, seq);
      else if (mutation.kind === 'putTxn') this.transactions.set(mutation.txId, mutation.txn, seq);
      else if (mutation.kind === 'putIdem') this.idem.set(mutation.requestId, mutation.result, seq);
    }
  }
}

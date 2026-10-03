import fs from 'node:fs';
import path from 'node:path';

export class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashError';
    this.code = 'E_CRASH';
    this.point = point;
  }
}

// WAL + MVCC storage engine.
//
// The WAL (wal.log, JSON lines) is the source of truth:
//   BEGIN   {type, txnId, op, requestId, args}   -- request spec, durable before changes
//   CHANGE  {type, txnId, key, value}            -- one business mutation
//   COMMIT  {type, txnId}                        -- commit record
//
// Recovery replays the log: transactions with a COMMIT record are applied
// (in lsn order, each stamped with a new MVCC version); transactions without
// one are rolled back. A torn tail line is ignored.
//
// MVCC: every key maps to a version chain [{version, value}]; reads see the
// latest committed version. committedVersion increases by 1 per committed txn.
export class Store {
  #dir;
  #walPath;
  #fd = null;
  #chains = new Map(); // key -> [{version, value}]
  #committedVersion = 0;
  #begins = []; // all BEGIN records ever seen (committed or not)
  #txnCounter = 0; // number of BEGINs ever seen; drives txnId allocation
  #crashed = false;

  constructor(dir) {
    this.#dir = dir;
    this.#walPath = path.join(dir, 'wal.log');
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    store.#recover();
    store.#fd = fs.openSync(store.#walPath, 'a');
    return store;
  }

  #recover() {
    if (!fs.existsSync(this.#walPath)) return;
    const content = fs.readFileSync(this.#walPath, 'utf8');
    const txns = new Map(); // txnId -> {changes, committed}
    const order = [];
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        break; // torn tail from a crash: ignore the rest
      }
      if (rec.type === 'BEGIN') {
        txns.set(rec.txnId, { changes: [], committed: false });
        order.push(rec.txnId);
        this.#begins.push(rec);
      } else if (rec.type === 'CHANGE') {
        txns.get(rec.txnId)?.changes.push(rec);
      } else if (rec.type === 'COMMIT') {
        const txn = txns.get(rec.txnId);
        if (txn) txn.committed = true;
      }
    }
    this.#txnCounter = order.length;
    for (const txnId of order) {
      const txn = txns.get(txnId);
      if (!txn.committed) continue; // roll back uncommitted (P1 crash)
      const version = ++this.#committedVersion;
      for (const change of txn.changes) this.#apply(change.key, change.value, version);
    }
  }

  #apply(key, value, version) {
    let chain = this.#chains.get(key);
    if (!chain) {
      chain = [];
      this.#chains.set(key, chain);
    }
    chain.push({ version, value });
  }

  #append(record) {
    fs.writeSync(this.#fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(this.#fd);
  }

  get crashed() {
    return this.#crashed;
  }

  get committedVersion() {
    return this.#committedVersion;
  }

  // Latest committed version of a key (MVCC read).
  get(key) {
    const chain = this.#chains.get(key);
    if (!chain || chain.length === 0) return undefined;
    return chain[chain.length - 1].value;
  }

  // All latest committed values whose key starts with prefix, as [key, value][].
  entries(prefix) {
    const out = [];
    for (const [key, chain] of this.#chains) {
      if (key.startsWith(prefix) && chain.length > 0) {
        out.push([key, chain[chain.length - 1].value]);
      }
    }
    return out;
  }

  nextTxnId() {
    return 'T' + String(this.#txnCounter + 1).padStart(6, '0');
  }

  // Request spec from any BEGIN record, committed or aborted (drives retry).
  findBegin(requestId) {
    return this.#begins.find((b) => b.requestId === requestId);
  }

  // Atomically (modulo simulated crashes) persist a transaction:
  // BEGIN -> CHANGE* -> [P1 crash point] -> COMMIT -> [P2 crash point] -> apply.
  commit({ txnId, op, requestId, args, changes }, crashAt) {
    if (this.#crashed) {
      const err = new Error('store instance is dead after a simulated crash; reopen');
      err.code = 'E_STORE_CRASHED';
      throw err;
    }
    const begin = { type: 'BEGIN', txnId, op, requestId, args };
    this.#append(begin);
    this.#begins.push(begin);
    this.#txnCounter++;
    for (const [key, value] of changes) {
      this.#append({ type: 'CHANGE', txnId, key, value });
    }
    if (crashAt === 'P1') {
      this.#crashed = true;
      throw new CrashError('P1');
    }
    this.#append({ type: 'COMMIT', txnId });
    if (crashAt === 'P2') {
      this.#crashed = true;
      throw new CrashError('P2');
    }
    const version = ++this.#committedVersion;
    for (const [key, value] of changes) this.#apply(key, value, version);
    return version;
  }

  close() {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd);
      this.#fd = null;
    }
  }
}

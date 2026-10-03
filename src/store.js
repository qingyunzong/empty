import fs from 'node:fs';
import path from 'node:path';
import { Wal } from './wal.js';
import { ConflictError, BudgetExceededError } from './errors.js';

// MVCC store with snapshot isolation:
//  - Every committed transaction writes a new version of each key in its
//    write set, tagged with its commit txid.
//  - A read transaction reads the latest version with txid <= its snapshot.
//  - A write transaction validates at commit: if any key in its write set
//    (including conditional-debit keys) gained a committed version newer
//    than its snapshot, the commit fails with CONFLICT.
//  - Conditional writes (budget debits) are re-validated at commit time
//    against the latest committed state: balance must not go negative,
//    otherwise the whole transaction fails with BUDGET_EXCEEDED and
//    nothing is applied.
// Commits are serialized through an internal lock, so concurrent debits on
// one account are judged in a serial order and can never overdraw.
export class Store {
  #versions = new Map(); // key -> [{ txid, value }] ascending by txid
  #txid = 0;
  #history = []; // committed tx records, in commit order
  #lock = Promise.resolve();

  constructor(dir) {
    this.dir = dir;
    this.walFile = path.join(dir, 'wal.log');
    this.wal = new Wal(this.walFile);
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    for (const commit of Wal.recover(store.walFile)) store.#apply(commit);
    return store;
  }

  #apply(commit) {
    for (const [key, value] of commit.writes) {
      let list = this.#versions.get(key);
      if (!list) this.#versions.set(key, (list = []));
      list.push({ txid: commit.txid, value });
    }
    this.#txid = Math.max(this.#txid, commit.txid);
    this.#history.push(commit);
  }

  get currentTxid() {
    return this.#txid;
  }

  get history() {
    return this.#history.map((c) => ({ txid: c.txid, ts: c.ts, keys: c.writes.map(([k]) => k) }));
  }

  begin() {
    return new Tx(this, this.#txid);
  }

  readAt(snapshot, key) {
    const list = this.#versions.get(key);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].txid <= snapshot) return list[i].value;
    }
    return undefined;
  }

  scanAt(snapshot, prefix) {
    const out = [];
    for (const key of [...this.#versions.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const value = this.readAt(snapshot, key);
      if (value !== undefined) out.push([key, value]);
    }
    return out;
  }

  async commit(tx, walOpts = {}) {
    const run = this.#lock.then(() => this.#commitNow(tx, walOpts));
    this.#lock = run.catch(() => {});
    return run;
  }

  #commitNow(tx, walOpts) {
    // 1. Write-write conflict detection (first-committer-wins).
    for (const key of tx.writeKeys()) {
      const list = this.#versions.get(key);
      if (list && list[list.length - 1].txid > tx.snapshot) {
        throw new ConflictError(`key "${key}" modified by a concurrent transaction`);
      }
    }
    // 2. Conditional writes: validate budget debits against the latest
    //    committed balances (conflict check above guarantees they equal the
    //    snapshot view for these keys).
    const balanceWrites = [];
    for (const [accKey, amount] of tx.debits) {
      const acct = this.readAt(this.#txid, accKey);
      const next = acct.balance - amount;
      if (next < 0) {
        throw new BudgetExceededError(
          `debit of ${amount} on "${accKey}" would make balance negative (${acct.balance})`,
        );
      }
      balanceWrites.push([accKey, { ...acct, balance: next }]);
    }
    // 3. Persist then apply: WAL first, in-memory versions second. If the
    //    WAL append crashes, nothing is applied and recovery ignores the
    //    torn record -- account and usage records live or die together.
    const txid = this.#txid + 1;
    const commit = { txid, ts: Date.now(), writes: [...tx.writes.entries(), ...balanceWrites] };
    this.wal.appendCommit(commit, walOpts);
    this.#apply(commit);
    return txid;
  }
}

export class Tx {
  constructor(store, snapshot) {
    this.store = store;
    this.snapshot = snapshot;
    this.writes = new Map(); // key -> value
    this.debits = new Map(); // account key -> total amount
  }

  get(key) {
    if (this.writes.has(key)) return this.writes.get(key);
    return this.store.readAt(this.snapshot, key);
  }

  put(key, value) {
    this.writes.set(key, value);
  }

  // Declare a conditional debit: validated against the real balance only
  // at commit time.
  debit(accountKey, amount) {
    this.debits.set(accountKey, (this.debits.get(accountKey) ?? 0) + amount);
  }

  writeKeys() {
    return new Set([...this.writes.keys(), ...this.debits.keys()]);
  }

  commit(walOpts = {}) {
    return this.store.commit(this, walOpts);
  }
}

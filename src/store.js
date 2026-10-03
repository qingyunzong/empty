'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CODES, StoreError } = require('./errors');
const { encodeFrame, recoverFrames } = require('./wal');

// MVCC transactional store with snapshot-isolation reads and
// first-committer-wins conflict detection on write-set intersection.
//
// Committed state is multi-versioned: every account keeps a version chain of
// balances, every usage record is tagged with the commit version that created
// it. A transaction reads at the snapshot version captured at begin(); its
// commit is validated against the latest committed state:
//   - write-write conflict: any debited account committed a newer version
//     after the transaction's snapshot -> CONFLICT (retryable)
//   - conditional write: declared debit amounts must not drive the latest
//     committed balance negative -> BUDGET_EXCEEDED, nothing applied
// Commits are serialized through a promise-chain lock, so concurrent debits
// on one account observe serialized outcomes and can never overdraw.

class Store {
  static open(dir) {
    const store = new Store(dir);
    store._load();
    return store;
  }

  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.version = 0;
    this.accounts = new Map(); // id -> [{ version, balance }] ascending by version
    this.usage = []; // { version, txid, accountId, amount, resource, units, ts }
    this.history = []; // committed commit-records, in order
    this._lock = Promise.resolve();
    this._fd = null;
  }

  _load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const record of recoverFrames(this.walPath)) {
      this._apply(record);
    }
    this._fd = fs.openSync(this.walPath, 'a');
  }

  close() {
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }
  }

  _apply(record) {
    if (record.type === 'create') {
      this.version = Math.max(this.version, record.txid);
      this.accounts.set(record.account, [{ version: record.txid, balance: record.balance }]);
    } else if (record.type === 'commit') {
      this.version = Math.max(this.version, record.txid);
      for (const debit of record.debits) {
        this.accounts.get(debit.account).push({ version: record.txid, balance: debit.balanceAfter });
      }
      for (const entry of record.usage) {
        this.usage.push({ version: record.txid, txid: record.txid, ...entry });
      }
      this.history.push(record);
    }
  }

  _balanceAt(id, version) {
    const chain = this.accounts.get(id);
    if (!chain) return null;
    let balance = null;
    for (const entry of chain) {
      if (entry.version > version) break;
      balance = entry.balance;
    }
    return balance;
  }

  _committedVersionOf(id) {
    const chain = this.accounts.get(id);
    return chain ? chain[chain.length - 1].version : null;
  }

  _enqueue(fn) {
    const run = this._lock.then(fn);
    this._lock = run.catch(() => {});
    return run;
  }

  createAccount(id, balance = 0) {
    if (!Number.isFinite(balance) || balance < 0) {
      throw new StoreError(CODES.INVALID_AMOUNT, `invalid initial balance: ${balance}`);
    }
    return this._enqueue(() => {
      if (this.accounts.has(id)) {
        throw new StoreError(CODES.ACCOUNT_EXISTS, `account already exists: ${id}`);
      }
      const record = { type: 'create', txid: this.version + 1, ts: new Date().toISOString(), account: id, balance };
      this._appendFrame(record);
      this._apply(record);
      return { txid: record.txid, account: id, balance };
    });
  }

  begin() {
    return new Transaction(this);
  }

  balanceOf(id) {
    const balance = this._balanceAt(id, this.version);
    if (balance === null) {
      throw new StoreError(CODES.NO_ACCOUNT, `no such account: ${id}`);
    }
    return balance;
  }

  usageOf(id = null) {
    return this.usage.filter(
      (entry) => entry.version <= this.version && (id === null || entry.accountId === id),
    );
  }

  getHistory(id = null) {
    if (id === null) return this.history.slice();
    return this.history.filter((record) =>
      record.type === 'commit' && record.debits.some((debit) => debit.account === id));
  }

  _appendFrame(record) {
    const frame = encodeFrame(record);
    fs.writeSync(this._fd, frame);
    fs.fsyncSync(this._fd);
  }

  _commit(tx) {
    return this._enqueue(() => this._commitLocked(tx));
  }

  _commitLocked(tx) {
    if (tx.done) {
      throw new StoreError(CODES.TX_CLOSED, 'transaction already committed or aborted');
    }
    tx.done = true;

    const entries = [...tx.debits];
    if (entries.length === 0) {
      return { txid: this.version, debits: [], usage: [] };
    }

    const debits = [];
    for (const [id, entry] of entries) {
      const committedVersion = this._committedVersionOf(id);
      if (committedVersion === null) {
        throw new StoreError(CODES.NO_ACCOUNT, `no such account: ${id}`);
      }
      if (committedVersion > tx.snapshot) {
        throw new StoreError(CODES.CONFLICT, `write-write conflict on account: ${id}`, { retryable: true });
      }
      const latest = this._balanceAt(id, this.version);
      const balanceAfter = latest - entry.amount;
      if (balanceAfter < 0) {
        throw new StoreError(
          CODES.BUDGET_EXCEEDED,
          `debit of ${entry.amount} exceeds balance ${latest} on account: ${id}`,
        );
      }
      debits.push({ account: id, amount: entry.amount, balanceAfter });
    }

    const usage = [];
    for (const [, entry] of entries) {
      usage.push(...entry.usage);
    }

    const record = {
      type: 'commit',
      txid: this.version + 1,
      ts: new Date().toISOString(),
      debits,
      usage,
    };
    this._appendFrame(record);
    this._apply(record);
    return { txid: record.txid, debits, usage };
  }
}

class Transaction {
  constructor(store) {
    this.store = store;
    this.snapshot = store.version;
    this.debits = new Map(); // accountId -> { amount, usage: [] }
    this.done = false;
  }

  _checkOpen() {
    if (this.done) {
      throw new StoreError(CODES.TX_CLOSED, 'transaction already committed or aborted');
    }
  }

  getBalance(id) {
    this._checkOpen();
    const balance = this.store._balanceAt(id, this.snapshot);
    if (balance === null) {
      throw new StoreError(CODES.NO_ACCOUNT, `no such account: ${id}`);
    }
    return balance;
  }

  getUsage(id = null) {
    this._checkOpen();
    return this.store.usage.filter(
      (entry) => entry.version <= this.snapshot && (id === null || entry.accountId === id),
    );
  }

  // Conditional write: declares a debit of `amount` plus its resource-usage
  // record. Validated against the latest committed balance at commit time.
  debit(id, amount, usage = {}) {
    this._checkOpen();
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new StoreError(CODES.INVALID_AMOUNT, `invalid debit amount: ${amount}`);
    }
    let entry = this.debits.get(id);
    if (!entry) {
      entry = { amount: 0, usage: [] };
      this.debits.set(id, entry);
    }
    entry.amount += amount;
    entry.usage.push({
      accountId: id,
      amount,
      resource: usage.resource ?? null,
      units: usage.units ?? amount,
      ts: new Date().toISOString(),
    });
  }

  commit() {
    return this.store._commit(this);
  }

  abort() {
    this.done = true;
  }
}

module.exports = { Store, Transaction };

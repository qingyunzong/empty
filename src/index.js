'use strict';

const { LockManager } = require('./lock-manager');
const { Wal } = require('./wal');
const {
  QuotaError,
  E_DEADLOCK,
  E_LOCK_TIMEOUT,
  E_INSUFFICIENT_FUNDS,
  E_TXN_STATE,
  E_NOT_FOUND,
} = require('./errors');

// Offline multi-account quota freezing engine.
//
// - A transaction freezes several accounts in one go; locks are taken per
//   account in ascending (priority, account) order.
// - Data is versioned with MVCC snapshots: readers see a stable snapshot,
//   but freeze validation at commit time always re-checks the latest
//   committed balances.
// - Freezes are journaled as PREPARE/COMMIT records in the WAL; after a
//   crash, prepared-but-uncommitted freezes are discarded and the lock
//   table starts empty.
class QuotaEngine {
  constructor({
    walPath = null,
    lockTimeoutMs = 200,
    now = () => Date.now(),
  } = {}) {
    this.walPath = walPath;
    this.wal = walPath ? new Wal(walPath) : null;
    this.lockTimeoutMs = lockTimeoutMs;
    this.now = now;
    this.locks = new LockManager({ lockTimeoutMs, now });
    // Deadlock victims that are not the current requester get aborted here.
    this.locks.onVictim = (victimTxnId) => {
      const victim = this.transactions.get(victimTxnId);
      if (victim && victim.state === 'active') this._abort(victim);
    };
    this.accounts = new Map(); // account -> { account, balance, priority }
    this.committedFreezes = new Map(); // freezeId -> { txnId, items }
    this.transactions = new Map(); // txnId -> txn record
    this.dataVersions = []; // [{ version, balances, priorities }]
    this.nextTxnId = 1;
    this.nextFreezeId = 1;
    this._open = false;
    this._recover();
  }

  static open(options) {
    const engine = new QuotaEngine(options);
    engine.open();
    return engine;
  }

  open() {
    if (this._open) return this;
    if (this.wal && !this.wal.isOpen) this.wal.open();
    this._open = true;
    this._pushVersion();
    return this;
  }

  close() {
    if (this.wal && this.wal.isOpen) this.wal.close();
    this._open = false;
  }

  // Crash recovery: replay committed state only. Any PREPARE without a
  // matching COMMIT is dropped, and the lock table is empty by construction.
  _recover() {
    if (!this.walPath) return;
    const { accounts, committedFreezes } = Wal.recover(this.walPath);
    this.accounts = accounts;
    for (const prepared of committedFreezes) {
      this.committedFreezes.set(prepared.freezeId, {
        txnId: prepared.txnId,
        items: prepared.items,
      });
      const maxFreeze = Number(String(prepared.freezeId).slice(1));
      if (Number.isFinite(maxFreeze) && maxFreeze >= this.nextFreezeId) {
        this.nextFreezeId = maxFreeze + 1;
      }
      const maxTxn = Number(String(prepared.txnId).slice(1));
      if (Number.isFinite(maxTxn) && maxTxn >= this.nextTxnId) {
        this.nextTxnId = maxTxn + 1;
      }
    }
    this.locks.clear();
  }

  // Simulate a process crash: the WAL stays on disk, every lock and every
  // in-flight transaction is discarded without writing anything further.
  crash() {
    if (this.wal && this.wal.isOpen) {
      this.wal.close();
    }
    this.locks.clear();
    this.transactions.clear();
    this._open = false;
  }

  addAccount(account, balance, priority = 0) {
    if (this.accounts.has(account)) {
      throw new QuotaError(E_TXN_STATE, `account ${account} already exists`);
    }
    const record = { account, balance, priority };
    this.accounts.set(account, record);
    if (this.wal && this.wal.isOpen) {
      this.wal.append({ type: 'INIT', account, balance, priority });
    }
    this._pushVersion();
    return record;
  }

  _pushVersion() {
    const balances = new Map();
    const priorities = new Map();
    for (const [name, record] of this.accounts) {
      balances.set(name, record.balance);
      priorities.set(name, record.priority);
    }
    this.dataVersions.push({
      version: this.dataVersions.length + 1,
      balances,
      priorities,
    });
  }

  snapshot() {
    if (this.dataVersions.length === 0) this._pushVersion();
    return this.dataVersions[this.dataVersions.length - 1];
  }

  frozenTotals(balances) {
    const totals = new Map();
    const source = balances || this.snapshot().balances;
    for (const name of source.keys()) totals.set(name, 0);
    for (const freeze of this.committedFreezes.values()) {
      for (const item of freeze.items) {
        if (totals.has(item.account)) {
          totals.set(item.account, totals.get(item.account) + item.amount);
        }
      }
    }
    return totals;
  }

  availableOf(account, balances) {
    const snap = balances || this.snapshot().balances;
    if (!snap.has(account)) {
      throw new QuotaError(E_NOT_FOUND, `unknown account ${account}`);
    }
    const frozen = this.frozenTotals(snap).get(account) || 0;
    return snap.get(account) - frozen;
  }

  query(account) {
    const snap = this.snapshot();
    if (!snap.balances.has(account)) {
      throw new QuotaError(E_NOT_FOUND, `unknown account ${account}`);
    }
    const frozen = this.frozenTotals(snap.balances).get(account) || 0;
    return {
      account,
      balance: snap.balances.get(account),
      frozen,
      available: snap.balances.get(account) - frozen,
      priority: snap.priorities.get(account),
      version: snap.version,
    };
  }

  // Freeze groups ordered by the (priority, account) secondary index.
  scanByPriority() {
    const groups = [];
    for (const [freezeId, freeze] of this.committedFreezes) {
      const key = freeze.items
        .map((item) => this._indexKey(item.account))
        .sort()
        .join('|');
      groups.push({ freezeId, txnId: freeze.txnId, items: freeze.items, key });
    }
    groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return groups;
  }

  _indexKey(account) {
    const record = this.accounts.get(account);
    const priority = record ? record.priority : 0;
    return `${String(priority).padStart(12, '0')}:${account}`;
  }

  begin() {
    const txnId = `T${this.nextTxnId++}`;
    const txn = {
      id: txnId,
      state: 'active',
      // MVCC: the transaction reads from this stable snapshot...
      snapshot: this.snapshot(),
      // ...but freeze validation uses the latest committed balances.
      latestBalances: this.snapshot().balances,
      heldLocks: [],
      pending: new Map(), // account -> amount
      preparedFreezeId: null,
    };
    this.transactions.set(txnId, txn);
    return txnId;
  }

  _txn(txnId) {
    const txn = this.transactions.get(txnId);
    if (!txn) throw new QuotaError(E_NOT_FOUND, `unknown txn ${txnId}`);
    return txn;
  }

  _assertActive(txn) {
    if (txn.state !== 'active') {
      throw new QuotaError(E_TXN_STATE, `txn ${txn.id} is ${txn.state}`);
    }
  }

  async freeze(txnId, account, amount, { timeoutMs } = {}) {
    const txn = this._txn(txnId);
    this._assertActive(txn);
    if (!this.accounts.has(account)) {
      throw new QuotaError(E_NOT_FOUND, `unknown account ${account}`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new QuotaError(E_TXN_STATE, `invalid freeze amount ${amount}`);
    }
    try {
      await this.locks.acquire(txnId, account, { timeoutMs });
    } catch (err) {
      if (err.code === E_DEADLOCK || err.code === E_LOCK_TIMEOUT) {
        this._abort(txn, err.code);
      }
      throw err;
    }
    txn.heldLocks.push(account);
    txn.pending.set(account, (txn.pending.get(account) || 0) + amount);
    return { txnId, account, amount };
  }

  // Unfreeze inside the transaction: drops the pending freeze and releases
  // the account lock immediately.
  unfreeze(txnId, account) {
    const txn = this._txn(txnId);
    this._assertActive(txn);
    if (!txn.pending.has(account)) {
      throw new QuotaError(E_NOT_FOUND, `no pending freeze on ${account}`);
    }
    txn.pending.delete(account);
    this.locks.release(txnId, account);
    txn.heldLocks = txn.heldLocks.filter((name) => name !== account);
    return { txnId, account, released: true };
  }

  // Journal PREPARE without committing; the transaction keeps its locks and
  // can still be committed (or lost in a crash, in which case the freeze
  // must never take effect).
  prepare(txnId) {
    const txn = this._txn(txnId);
    this._assertActive(txn);
    const freezeId = `F${this.nextFreezeId}`;
    const items = [...txn.pending].map(([account, amount]) => ({
      account,
      amount,
    }));
    if (this.wal && this.wal.isOpen) {
      this.wal.append({ type: 'PREPARE', txnId, freezeId, items });
    }
    txn.state = 'prepared';
    txn.preparedFreezeId = freezeId;
    return { txnId, freezeId, items };
  }

  async commit(txnId) {
    const txn = this._txn(txnId);
    if (txn.state !== 'active' && txn.state !== 'prepared') {
      throw new QuotaError(E_TXN_STATE, `txn ${txn.id} is ${txn.state}`);
    }
    // Freeze validation is based on the latest committed balances, not on
    // the transaction's MVCC snapshot.
    const latest = this.snapshot().balances;
    const frozen = this.frozenTotals(latest);
    const items = [];
    for (const [account, amount] of txn.pending) {
      const available = latest.get(account) - (frozen.get(account) || 0);
      if (amount > available) {
        this._abort(txn, E_INSUFFICIENT_FUNDS);
        throw new QuotaError(
          E_INSUFFICIENT_FUNDS,
          `account ${account} available ${available} < requested ${amount}`
        );
      }
      items.push({ account, amount });
    }
    if (items.length === 0) {
      txn.state = 'committed';
      this._releaseLocks(txn);
      return { txnId, freezeId: null, items };
    }
    let freezeId;
    if (txn.state === 'prepared') {
      freezeId = txn.preparedFreezeId;
      this.nextFreezeId++;
    } else {
      freezeId = `F${this.nextFreezeId++}`;
      if (this.wal && this.wal.isOpen) {
        this.wal.append({ type: 'PREPARE', txnId, freezeId, items });
      }
    }
    this.committedFreezes.set(freezeId, { txnId, items });
    this._pushVersion(); // committed state advanced -> new MVCC data version
    if (this.wal && this.wal.isOpen) {
      this.wal.append({ type: 'COMMIT', txnId, freezeId });
    }
    txn.state = 'committed';
    this._releaseLocks(txn);
    return { txnId, freezeId, items };
  }

  abort(txnId) {
    const txn = this._txn(txnId);
    if (txn.state !== 'active' && txn.state !== 'prepared') {
      return { txnId, state: txn.state };
    }
    this._abort(txn);
    return { txnId, state: 'aborted' };
  }

  _abort(txn, code = E_DEADLOCK) {
    if (txn.state !== 'active' && txn.state !== 'prepared') return;
    txn.state = 'aborted';
    txn.pending.clear();
    if (this.wal && this.wal.isOpen) {
      this.wal.append({ type: 'ABORT', txnId: txn.id });
    }
    this._releaseLocks(txn, code);
  }

  _releaseLocks(txn, code) {
    this.locks.releaseAll(txn.id, code);
    txn.heldLocks = [];
  }
}

module.exports = {
  QuotaEngine,
  LockManager,
  Wal,
  QuotaError,
  E_DEADLOCK,
  E_LOCK_TIMEOUT,
  E_INSUFFICIENT_FUNDS,
  E_TXN_STATE,
  E_NOT_FOUND,
};

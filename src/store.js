'use strict';

class LedgerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const HOLD_STATUS = Object.freeze({ HELD: 'HELD', RELEASED: 'RELEASED', SETTLED: 'SETTLED' });
const PAYMENT_STATUS = Object.freeze({ PAID: 'PAID', CANCELLED: 'CANCELLED' });

const SEP = '';
const keyAS = (account, status) => account + SEP + status;

class Store {
  constructor() {
    this.accounts = new Map(); // id -> { id, total, version }
    this.holds = new Map();    // id -> { id, account, amount, dueDate, status, version }
    this.payments = new Map(); // id -> { id, account, holdId, amount, status, version }
    this.refunds = [];         // { id, paymentId, account, amount }
    // Secondary indexes over holds, maintained atomically at commit time:
    this.idxAccountStatus = new Map(); // "account<SEP>status" -> Set(holdId)
    this.idxDueStatus = new Map();     // status -> Map(dueDate -> Set(holdId))
  }

  begin() {
    return new Transaction(this);
  }

  _indexAdd(hold) {
    const key = keyAS(hold.account, hold.status);
    let set = this.idxAccountStatus.get(key);
    if (!set) {
      set = new Set();
      this.idxAccountStatus.set(key, set);
    }
    set.add(hold.id);
    let byStatus = this.idxDueStatus.get(hold.status);
    if (!byStatus) {
      byStatus = new Map();
      this.idxDueStatus.set(hold.status, byStatus);
    }
    let bucket = byStatus.get(hold.dueDate);
    if (!bucket) {
      bucket = new Set();
      byStatus.set(hold.dueDate, bucket);
    }
    bucket.add(hold.id);
  }

  _indexRemove(hold) {
    const key = keyAS(hold.account, hold.status);
    const set = this.idxAccountStatus.get(key);
    if (set) {
      set.delete(hold.id);
      if (set.size === 0) this.idxAccountStatus.delete(key);
    }
    const byStatus = this.idxDueStatus.get(hold.status);
    if (byStatus) {
      const bucket = byStatus.get(hold.dueDate);
      if (bucket) {
        bucket.delete(hold.id);
        if (bucket.size === 0) byStatus.delete(hold.dueDate);
      }
      if (byStatus.size === 0) this.idxDueStatus.delete(hold.status);
    }
  }

  rebuildIndexes() {
    this.idxAccountStatus.clear();
    this.idxDueStatus.clear();
    for (const hold of this.holds.values()) this._indexAdd(hold);
  }

  // Index-backed query; every candidate is re-validated against the hold record.
  queryHolds({ account, status, dueBefore } = {}) {
    let candidates;
    if (account !== undefined && status !== undefined) {
      candidates = new Set(this.idxAccountStatus.get(keyAS(account, status)) || []);
    } else if (status !== undefined) {
      candidates = new Set();
      const byStatus = this.idxDueStatus.get(status);
      if (byStatus) {
        for (const [dueDate, bucket] of byStatus) {
          if (dueBefore === undefined || dueDate < dueBefore) {
            for (const id of bucket) candidates.add(id);
          }
        }
      }
    } else if (account !== undefined) {
      candidates = new Set();
      const prefix = account + SEP;
      for (const [key, set] of this.idxAccountStatus) {
        if (key.startsWith(prefix)) for (const id of set) candidates.add(id);
      }
    } else if (dueBefore !== undefined) {
      candidates = new Set();
      for (const byStatus of this.idxDueStatus.values()) {
        for (const [dueDate, bucket] of byStatus) {
          if (dueDate < dueBefore) for (const id of bucket) candidates.add(id);
        }
      }
    } else {
      candidates = new Set(this.holds.keys());
    }
    const out = [];
    for (const id of candidates) {
      const hold = this.holds.get(id);
      if (!hold) continue;
      if (account !== undefined && hold.account !== account) continue;
      if (status !== undefined && hold.status !== status) continue;
      if (dueBefore !== undefined && !(hold.dueDate < dueBefore)) continue;
      out.push({ ...hold });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  available(accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc) throw new LedgerError('E_NO_ACCOUNT', `unknown account ${accountId}`);
    let held = 0;
    for (const hold of this.holds.values()) {
      if (hold.account === accountId && hold.status === HOLD_STATUS.HELD) held += hold.amount;
    }
    return acc.total - held;
  }
}

class Transaction {
  constructor(store) {
    this.store = store;
    this.active = true;
    // Read-set base versions (and hold status) captured at first read: snapshot reads.
    this.baseAccounts = new Map(); // id -> version | null
    this.baseHolds = new Map();    // id -> { version, status } | null
    this.basePayments = new Map(); // id -> version | null
    // Write-set, applied atomically at commit.
    this.wAccounts = new Map();
    this.wHolds = new Map();
    this.wPayments = new Map();
    this.wRefunds = [];
  }

  _assertActive() {
    if (!this.active) throw new LedgerError('E_TX_CLOSED', 'transaction already finished');
  }

  _getAccount(id) {
    if (this.wAccounts.has(id)) return this.wAccounts.get(id);
    const rec = this.store.accounts.get(id);
    if (!this.baseAccounts.has(id)) this.baseAccounts.set(id, rec ? rec.version : null);
    return rec ? { ...rec } : undefined;
  }

  _getHold(id) {
    if (this.wHolds.has(id)) return this.wHolds.get(id);
    const rec = this.store.holds.get(id);
    if (!this.baseHolds.has(id)) {
      this.baseHolds.set(id, rec ? { version: rec.version, status: rec.status } : null);
    }
    return rec ? { ...rec } : undefined;
  }

  _peekHold(id) {
    if (this.wHolds.has(id)) return this.wHolds.get(id);
    return this.store.holds.get(id);
  }

  _trackHold(id) {
    if (this.wHolds.has(id) || this.baseHolds.has(id)) return;
    const rec = this.store.holds.get(id);
    this.baseHolds.set(id, rec ? { version: rec.version, status: rec.status } : null);
  }

  _getPayment(id) {
    if (this.wPayments.has(id)) return this.wPayments.get(id);
    const rec = this.store.payments.get(id);
    if (!this.basePayments.has(id)) this.basePayments.set(id, rec ? rec.version : null);
    return rec ? { ...rec } : undefined;
  }

  available(accountId) {
    this._assertActive();
    const acc = this._getAccount(accountId);
    if (!acc) throw new LedgerError('E_NO_ACCOUNT', `unknown account ${accountId}`);
    let held = 0;
    const ids = new Set([...this.store.holds.keys(), ...this.wHolds.keys()]);
    for (const id of ids) {
      const hold = this._peekHold(id);
      if (hold && hold.account === accountId) {
        this._trackHold(id);
        if (hold.status === HOLD_STATUS.HELD) held += hold.amount;
      }
    }
    return acc.total - held;
  }

  createAccount(id, total) {
    this._assertActive();
    if (typeof total !== 'number' || !(total >= 0)) {
      throw new LedgerError('E_BAD_AMOUNT', 'total must be a non-negative number');
    }
    if (this._getAccount(id)) throw new LedgerError('E_ACCOUNT_EXISTS', `account ${id} exists`);
    this.wAccounts.set(id, { id, total, version: 0 });
    return { id, total };
  }

  freeze({ account, holdId, amount, dueDate }) {
    this._assertActive();
    if (typeof amount !== 'number' || !(amount > 0)) {
      throw new LedgerError('E_BAD_AMOUNT', 'amount must be a positive number');
    }
    const acc = this._getAccount(account);
    if (!acc) throw new LedgerError('E_NO_ACCOUNT', `unknown account ${account}`);
    if (this._getHold(holdId)) throw new LedgerError('E_HOLD_EXISTS', `hold ${holdId} exists`);
    const avail = this.available(account);
    if (amount > avail) {
      throw new LedgerError('E_INSUFFICIENT', `amount ${amount} exceeds available ${avail}`);
    }
    this.wHolds.set(holdId, {
      id: holdId, account, amount, dueDate, status: HOLD_STATUS.HELD, version: 0,
    });
    this.wAccounts.set(account, { ...acc }); // dirty: bumps balance version at commit
    return { holdId, available: avail - amount };
  }

  pay({ holdId, paymentId, amount }) {
    this._assertActive();
    const hold = this._getHold(holdId);
    if (!hold) throw new LedgerError('E_NO_HOLD', `unknown hold ${holdId}`);
    if (hold.status !== HOLD_STATUS.HELD) {
      throw new LedgerError('E_HOLD_STATE', `hold ${holdId} is ${hold.status}`);
    }
    if (this._getPayment(paymentId)) {
      throw new LedgerError('E_PAYMENT_EXISTS', `payment ${paymentId} exists`);
    }
    const payAmount = amount === undefined ? hold.amount : amount;
    if (typeof payAmount !== 'number' || !(payAmount > 0)) {
      throw new LedgerError('E_BAD_AMOUNT', 'amount must be a positive number');
    }
    const acc = this._getAccount(hold.account);
    if (!acc) throw new LedgerError('E_NO_ACCOUNT', `unknown account ${hold.account}`);
    const extra = payAmount - hold.amount;
    if (extra > 0 && extra > this.available(hold.account)) {
      throw new LedgerError('E_INSUFFICIENT', `amount ${payAmount} exceeds hold plus available`);
    }
    this.wHolds.set(holdId, { ...hold, status: HOLD_STATUS.SETTLED });
    this.wAccounts.set(acc.id, { ...acc, total: acc.total - payAmount });
    this.wPayments.set(paymentId, {
      id: paymentId, account: hold.account, holdId, amount: payAmount,
      status: PAYMENT_STATUS.PAID, version: 0,
    });
    return { paymentId, amount: payAmount, total: acc.total - payAmount };
  }

  release({ holdId }) {
    this._assertActive();
    const hold = this._getHold(holdId);
    if (!hold) throw new LedgerError('E_NO_HOLD', `unknown hold ${holdId}`);
    if (hold.status !== HOLD_STATUS.HELD) {
      throw new LedgerError('E_HOLD_STATE', `hold ${holdId} is ${hold.status}`);
    }
    const acc = this._getAccount(hold.account);
    if (!acc) throw new LedgerError('E_NO_ACCOUNT', `unknown account ${hold.account}`);
    this.wHolds.set(holdId, { ...hold, status: HOLD_STATUS.RELEASED });
    this.wAccounts.set(acc.id, { ...acc }); // dirty: available changed
    return { holdId, status: HOLD_STATUS.RELEASED };
  }

  cancelPay({ paymentId, refundId }) {
    this._assertActive();
    const payment = this._getPayment(paymentId);
    if (!payment) throw new LedgerError('E_NO_PAYMENT', `unknown payment ${paymentId}`);
    if (payment.status !== PAYMENT_STATUS.PAID) {
      throw new LedgerError('E_PAY_STATE', `payment ${paymentId} is ${payment.status}`);
    }
    const acc = this._getAccount(payment.account);
    if (!acc) throw new LedgerError('E_NO_ACCOUNT', `unknown account ${payment.account}`);
    this.wPayments.set(paymentId, { ...payment, status: PAYMENT_STATUS.CANCELLED });
    this.wAccounts.set(acc.id, { ...acc, total: acc.total + payment.amount });
    const refund = {
      id: refundId || `rf_${paymentId}`,
      paymentId,
      account: payment.account,
      amount: payment.amount,
    };
    this.wRefunds.push(refund);
    return refund;
  }

  commit() {
    this._assertActive();
    const store = this.store;
    // Validation: account balance versions and hold versions/status must be
    // unchanged since the snapshot was taken.
    for (const [id, version] of this.baseAccounts) {
      const cur = store.accounts.get(id);
      if ((cur ? cur.version : null) !== version) {
        throw new LedgerError('E_CONFLICT', `account ${id} modified concurrently`);
      }
    }
    for (const [id, base] of this.baseHolds) {
      const cur = store.holds.get(id);
      if (base === null) {
        if (cur) throw new LedgerError('E_CONFLICT', `hold ${id} created concurrently`);
      } else if (!cur || cur.version !== base.version || cur.status !== base.status) {
        throw new LedgerError('E_CONFLICT', `hold ${id} modified concurrently`);
      }
    }
    for (const [id, version] of this.basePayments) {
      const cur = store.payments.get(id);
      if ((cur ? cur.version : null) !== version) {
        throw new LedgerError('E_CONFLICT', `payment ${id} modified concurrently`);
      }
    }
    // Apply: records and secondary indexes become visible atomically.
    for (const [id, rec] of this.wAccounts) {
      const prev = store.accounts.get(id);
      store.accounts.set(id, { ...rec, version: (prev ? prev.version : 0) + 1 });
    }
    for (const [id, rec] of this.wHolds) {
      const prev = store.holds.get(id);
      if (prev) store._indexRemove(prev);
      const next = { ...rec, version: (prev ? prev.version : 0) + 1 };
      store.holds.set(id, next);
      store._indexAdd(next);
    }
    for (const [id, rec] of this.wPayments) {
      const prev = store.payments.get(id);
      store.payments.set(id, { ...rec, version: (prev ? prev.version : 0) + 1 });
    }
    for (const refund of this.wRefunds) store.refunds.push(refund);
    this.active = false;
  }
}

function toJSON(store) {
  return {
    accounts: [...store.accounts.values()],
    holds: [...store.holds.values()],
    payments: [...store.payments.values()],
    refunds: store.refunds,
  };
}

function fromJSON(data) {
  const store = new Store();
  for (const acc of data.accounts || []) store.accounts.set(acc.id, acc);
  for (const hold of data.holds || []) store.holds.set(hold.id, hold);
  for (const payment of data.payments || []) store.payments.set(payment.id, payment);
  store.refunds = data.refunds || [];
  store.rebuildIndexes();
  return store;
}

module.exports = {
  Store,
  Transaction,
  LedgerError,
  HOLD_STATUS,
  PAYMENT_STATUS,
  toJSON,
  fromJSON,
};

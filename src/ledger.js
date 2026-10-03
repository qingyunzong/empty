'use strict';

const crypto = require('node:crypto');
const { Wal } = require('./wal');
const { LedgerError } = require('./errors');

const EXIT_CRASH = 75;

class CrashExit extends Error {
  constructor(code) {
    super(`simulated crash, exit code ${code}`);
    this.code = code;
    this.isCrashExit = true;
  }
}

class Ledger {
  constructor(walPath, options = {}) {
    this.wal = new Wal(walPath);
    this.crashPoint = options.crashPoint || null;
    this.onBeforeExit = options.onBeforeExit || null;
    this.exit = options.exit || ((code) => process.exit(code));
    this.txns = new Map(); // txnId -> { kind, merchant, amount, cancelled }
    this.entries = []; // applied change records (PAY + reversing CANCEL)
    this.balances = new Map(); // merchant -> cents
    this.discardedBytes = 0;
  }

  open() {
    const { discardedBytes } = this.wal.recover();
    this.discardedBytes = discardedBytes;
    this._replay();
    return this;
  }

  _replay() {
    const records = this.wal.frames.map((f) => f.record);
    const committed = new Set();
    for (const r of records) {
      if (r && r.type === 'COMMIT' && typeof r.txnId === 'string') {
        committed.add(r.txnId);
      }
    }
    for (const r of records) {
      if (!r || (r.type !== 'PAY' && r.type !== 'CANCEL')) continue;
      if (!committed.has(r.txnId)) continue; // no COMMIT -> discard
      this._apply(r);
    }
  }

  _apply(record) {
    if (record.type === 'PAY') {
      this.txns.set(record.txnId, {
        kind: 'PAY',
        merchant: record.merchant,
        amount: record.amount,
        cancelled: false,
      });
      this._addBalance(record.merchant, record.amount);
      this.entries.push(record);
    } else if (record.type === 'CANCEL') {
      const orig = this.txns.get(record.ref);
      if (orig) orig.cancelled = true;
      this.txns.set(record.txnId, {
        kind: 'CANCEL',
        merchant: record.merchant,
        amount: record.amount,
        ref: record.ref,
        cancelled: false,
      });
      this._addBalance(record.merchant, record.amount); // amount is negative
      this.entries.push(record);
    }
  }

  _addBalance(merchant, delta) {
    this.balances.set(merchant, (this.balances.get(merchant) || 0) + delta);
  }

  // Commit protocol: append change record, append COMMIT, fsync, then return.
  _commit(record) {
    this.wal.append(record);
    if (this.crashPoint === 'P1') this._crash();
    this.wal.append({ type: 'COMMIT', txnId: record.txnId });
    this.wal.fsync();
    if (this.crashPoint === 'P2') this._crash();
    this._apply(record);
    return record;
  }

  _crash() {
    this.wal.fsync();
    if (this.onBeforeExit) this.onBeforeExit();
    this.exit(EXIT_CRASH);
  }

  pay({ merchant, amount, id }) {
    if (typeof merchant !== 'string' || merchant.length === 0) {
      throw new LedgerError('E_INVALID_ARGS', 'merchant must be a non-empty string');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new LedgerError('E_INVALID_AMOUNT', 'amount must be a positive integer (cents)');
    }
    const txnId = id || `tx_${crypto.randomUUID()}`;
    if (this.txns.has(txnId)) {
      throw new LedgerError('E_DUPLICATE_TXN', `transaction ${txnId} already exists`);
    }
    return this._commit({ type: 'PAY', txnId, merchant, amount, ts: Date.now() });
  }

  cancel({ txnId }) {
    const orig = this.txns.get(txnId);
    if (!orig) {
      throw new LedgerError('E_TXN_NOT_FOUND', `transaction ${txnId} not found`);
    }
    if (orig.kind !== 'PAY') {
      throw new LedgerError('E_NOT_CANCELLABLE', `transaction ${txnId} is not a payment`);
    }
    if (orig.cancelled) {
      throw new LedgerError('E_ALREADY_CANCELLED', `transaction ${txnId} already cancelled`);
    }
    const cancelId = `cx_${crypto.randomUUID()}`;
    return this._commit({
      type: 'CANCEL',
      txnId: cancelId,
      ref: txnId,
      merchant: orig.merchant,
      amount: -orig.amount, // reversing entry
      ts: Date.now(),
    });
  }

  audit(merchant) {
    const entries = this.entries.filter((e) => e.merchant === merchant);
    return {
      merchant,
      balance: this.balances.get(merchant) || 0,
      entries,
    };
  }

  stats() {
    return {
      frames: this.wal.frames.length,
      transactions: this.txns.size,
      discardedBytes: this.discardedBytes,
      balances: Object.fromEntries(this.balances),
    };
  }
}

module.exports = { Ledger, EXIT_CRASH, CrashExit };

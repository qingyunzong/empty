'use strict';

const { CODES, LedgerError } = require('./errors');
const { hashState } = require('./hash');

// 追加式账本：分录只追加不删除，回滚通过状态标记与冲正分录完成。
class Ledger {
  constructor() {
    this.entries = []; // append-only log, seq = index + 1
    this.batches = new Map(); // id -> { id, parentId, status, createdSeq }
    this.savepoints = new Map(); // name -> savepoint
    this.seq = 0;
  }

  _requireBatch(id, { allowSettled = false } = {}) {
    const batch = this.batches.get(id);
    if (!batch) throw new LedgerError(CODES.DEPEND, `unknown batch: ${id}`);
    if (batch.status === 'rolled_back') {
      throw new LedgerError(CODES.DEPEND, `batch already rolled back: ${id}`);
    }
    if (!allowSettled && batch.status === 'settled') {
      throw new LedgerError(CODES.DEPEND, `batch already settled: ${id}`);
    }
    return batch;
  }

  openBatch(id, parentId = null) {
    if (this.batches.has(id)) throw new LedgerError(CODES.DEPEND, `duplicate batch: ${id}`);
    if (parentId !== null) this._requireBatch(parentId, { allowSettled: true });
    const batch = { id, parentId, status: 'open', createdSeq: this.seq };
    this.batches.set(id, batch);
    return batch;
  }

  post(batchId, { account, amount, day = 0 }) {
    this._requireBatch(batchId);
    const last = this.entries[this.entries.length - 1];
    if (last && day < last.day) {
      throw new LedgerError(CODES.BOUNDARY, `day regression: ${day} < ${last.day}`);
    }
    const entry = {
      seq: ++this.seq, batchId, kind: 'post', account, amount, day,
      status: 'posted', correctedBy: null, supersedes: null, reverses: null,
    };
    this.entries.push(entry);
    return entry;
  }

  correct(entrySeq, amount) {
    const orig = this.entries[entrySeq - 1];
    if (!orig || orig.kind !== 'post') {
      throw new LedgerError(CODES.SNAP, `not a correctable post entry: ${entrySeq}`);
    }
    if (orig.status !== 'posted' && orig.status !== 'settled') {
      throw new LedgerError(CODES.DEPEND, `entry ${entrySeq} not correctable in status ${orig.status}`);
    }
    const entry = {
      seq: ++this.seq, batchId: orig.batchId, kind: 'correction', account: orig.account,
      amount, day: orig.day, status: 'posted', correctedBy: null, supersedes: entrySeq, reverses: null,
    };
    let head = orig;
    while (head.correctedBy !== null) head = this.entries[head.correctedBy - 1];
    head.correctedBy = entry.seq;
    this.entries.push(entry);
    return entry;
  }

  settleBatch(batchId) {
    const batch = this._requireBatch(batchId);
    batch.status = 'settled';
    for (const e of this.entries) {
      if (e.batchId === batchId && e.status === 'posted') e.status = 'settled';
    }
    return batch;
  }

  // 有效金额：沿更正链取最新未被回滚的更正。
  effectiveAmount(entry) {
    let current = entry;
    let amount = entry.amount;
    while (current.correctedBy !== null) {
      const next = this.entries[current.correctedBy - 1];
      if (!next || next.status === 'rolled_back') break;
      current = next;
      amount = next.amount;
    }
    return amount;
  }

  createSavepoint(name, { batchId, atSeq = this.seq } = {}) {
    const batch = this.batches.get(batchId);
    if (!batch) throw new LedgerError(CODES.DEPEND, `unknown batch: ${batchId}`);
    if (batch.status === 'rolled_back') {
      throw new LedgerError(CODES.DEPEND, `batch already rolled back: ${batchId}`);
    }
    if (this.savepoints.has(name)) {
      throw new LedgerError(CODES.SNAP, `duplicate savepoint: ${name}`);
    }
    if (!Number.isInteger(atSeq) || atSeq < 0 || atSeq > this.seq) {
      throw new LedgerError(CODES.BOUNDARY, `atSeq out of range: ${atSeq} (seq=${this.seq})`);
    }
    const atEntry = atSeq === 0 ? null : this.entries[atSeq - 1];
    const day = atEntry ? atEntry.day : 0;
    const next = atSeq < this.seq ? this.entries[atSeq] : null;
    if (next && next.day === day) {
      throw new LedgerError(CODES.BOUNDARY, `savepoint splits day ${day} at seq ${atSeq}`);
    }
    const snapshot = this._capture(atSeq);
    const savepoint = { name, batchId, atSeq, day, snapshot, hash: hashState(snapshot), consumed: false };
    this.savepoints.set(name, savepoint);
    return savepoint;
  }

  _capture(uptoSeq) {
    const batches = [...this.batches.values()]
      .filter((b) => b.createdSeq <= uptoSeq && b.status !== 'rolled_back')
      .map((b) => ({ id: b.id, parentId: b.parentId, status: b.status }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const entries = this.entries
      .filter((e) => e.seq <= uptoSeq && e.kind === 'post' && (e.status === 'posted' || e.status === 'settled'))
      .map((e) => ({
        seq: e.seq, batchId: e.batchId, account: e.account,
        amount: this.effectiveAmount(e), day: e.day, status: e.status,
      }));
    return { batches, entries };
  }

  // 余额口径：post 分录（rolled_back 除外）按有效金额计入；reversed 原始分录仍在账，
  // 其冲正分录（reversal）以负额计入，二者对冲为零。correction 不直接计账。
  balances() {
    const map = new Map();
    for (const e of this.entries) {
      if (e.kind === 'correction') continue;
      if (e.kind === 'reversal') {
        map.set(e.account, (map.get(e.account) || 0) + e.amount);
        continue;
      }
      if (e.status === 'rolled_back') continue;
      map.set(e.account, (map.get(e.account) || 0) + this.effectiveAmount(e));
    }
    const out = {};
    for (const [k, v] of [...map.entries()].sort()) if (v !== 0) out[k] = v;
    return out;
  }

  stateHash() {
    const batches = [...this.batches.values()]
      .filter((b) => b.status !== 'rolled_back')
      .map((b) => ({ id: b.id, parentId: b.parentId, status: b.status }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const entries = this.entries
      .filter((e) => e.kind !== 'correction' && e.status !== 'rolled_back')
      .map((e) => ({
        seq: e.seq, batchId: e.batchId, kind: e.kind, account: e.account,
        amount: e.kind === 'reversal' ? e.amount : this.effectiveAmount(e), status: e.status,
      }));
    return hashState({ batches, entries, balances: this.balances() });
  }
}

module.exports = { Ledger };

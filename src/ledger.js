import { createHash } from 'node:crypto';

export const ERR = Object.freeze({
  SNAP: 'E_SNAP',
  DEPEND: 'E_DEPEND',
  ORPHAN: 'E_ORPHAN',
  BOUNDARY: 'E_BOUNDARY',
  INVAL: 'E_INVAL',
});

export class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export class Ledger {
  constructor() {
    this.seq = 0;
    this.batches = new Map();
    this.txs = new Map();
    this.log = [];
    this.savepoints = new Map();
    this.closedDays = new Set();
    this.balancesMap = new Map();
  }

  _nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  _bump(account, delta) {
    this.balancesMap.set(account, (this.balancesMap.get(account) ?? 0) + delta);
  }

  _getBatch(id) {
    const batch = this.batches.get(id);
    if (!batch || batch.status === 'rolledback') {
      throw new LedgerError(ERR.DEPEND, `batch ${id} not found or rolled back`);
    }
    return batch;
  }

  _assertAncestorsIntact(batch) {
    let current = batch;
    while (current.parentId != null) {
      const parent = this.batches.get(current.parentId);
      if (!parent || parent.status === 'rolledback') {
        throw new LedgerError(
          ERR.DEPEND,
          `dependency broken: parent batch ${current.parentId} of ${current.id} missing or rolled back`,
        );
      }
      current = parent;
    }
  }

  _subtreeIds(rootId) {
    const ids = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const batch of this.batches.values()) {
        if (batch.parentId != null && ids.has(batch.parentId) && !ids.has(batch.id)) {
          ids.add(batch.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  createBatch({ id, parentId = null, day }) {
    if (this.batches.has(id)) {
      throw new LedgerError(ERR.INVAL, `batch ${id} already exists`);
    }
    if (parentId != null) this._getBatch(parentId);
    if (this.closedDays.has(day)) {
      throw new LedgerError(ERR.BOUNDARY, `day ${day} is closed`, { day });
    }
    const batch = { id, parentId, day, status: 'open', createdSeq: this._nextSeq() };
    this.batches.set(id, batch);
    return batch;
  }

  addTx({ id, batchId, account, amount, day, corrects = null, reverses = null }) {
    if (this.txs.has(id)) {
      throw new LedgerError(ERR.INVAL, `tx ${id} already exists`);
    }
    this._getBatch(batchId);
    if (this.closedDays.has(day)) {
      throw new LedgerError(ERR.BOUNDARY, `day ${day} is closed`, { day });
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new LedgerError(ERR.INVAL, `tx ${id} amount must be a finite number`);
    }
    if (corrects != null) {
      const target = this.txs.get(corrects);
      if (!target || target.status === 'void') {
        throw new LedgerError(ERR.DEPEND, `correction target ${corrects} not found`);
      }
      if (target.status === 'corrected') {
        throw new LedgerError(ERR.DEPEND, `tx ${corrects} already corrected by ${target.correctedBy}`);
      }
      if (target.account !== account) {
        throw new LedgerError(ERR.INVAL, 'correction must keep the original account');
      }
    }
    const tx = {
      id,
      batchId,
      account,
      amount,
      day,
      corrects,
      reverses,
      seq: this._nextSeq(),
      status: 'active',
      correctedBy: null,
      reversedBy: null,
    };
    this.txs.set(id, tx);
    this.log.push(tx);
    if (corrects != null) {
      const target = this.txs.get(corrects);
      target.status = 'corrected';
      target.correctedBy = id;
      this._bump(target.account, -target.amount);
    }
    this._bump(account, amount);
    return tx;
  }

  settleBatch(id) {
    const batch = this._getBatch(id);
    if (batch.status === 'settled') {
      throw new LedgerError(ERR.INVAL, `batch ${id} already settled`);
    }
    if (batch.parentId != null) {
      const parent = this.batches.get(batch.parentId);
      if (parent.status !== 'settled') {
        throw new LedgerError(ERR.DEPEND, `parent batch ${batch.parentId} not settled`);
      }
    }
    batch.status = 'settled';
    for (const tx of this.log) {
      if (tx.batchId === id && tx.status === 'active') tx.status = 'settled';
    }
    return batch;
  }

  closeDay(day) {
    this.closedDays.add(day);
    return day;
  }

  createSavepoint({ id, batchId }) {
    if (this.savepoints.has(id)) {
      throw new LedgerError(ERR.SNAP, `savepoint ${id} already exists`);
    }
    const batch = this.batches.get(batchId);
    if (!batch || batch.status === 'rolledback') {
      throw new LedgerError(ERR.SNAP, `cannot snapshot missing or rolled-back batch ${batchId}`);
    }
    this._assertAncestorsIntact(batch);
    const savepoint = { id, batchId, seq: this.seq, day: batch.day, hash: this.hash() };
    this.savepoints.set(id, savepoint);
    return savepoint;
  }

  planRollback(savepointId, { reverse = false } = {}) {
    const savepoint = this.savepoints.get(savepointId);
    if (!savepoint) {
      throw new LedgerError(ERR.SNAP, `savepoint ${savepointId} not found`);
    }
    const target = this.batches.get(savepoint.batchId);
    if (!target || target.status === 'rolledback') {
      throw new LedgerError(
        ERR.SNAP,
        `dangling restore refused: batch ${savepoint.batchId} no longer exists`,
      );
    }
    this._assertAncestorsIntact(target);

    const subtree = this._subtreeIds(savepoint.batchId);
    const candidates = this.log.filter(
      (tx) => subtree.has(tx.batchId) && tx.seq > savepoint.seq && tx.status !== 'void',
    );

    const removalIds = new Set();
    for (const tx of candidates) {
      if (tx.corrects == null) removalIds.add(tx.id);
    }
    const carryForward = [];
    for (const tx of candidates) {
      if (tx.corrects == null) continue;
      if (removalIds.has(tx.corrects)) {
        removalIds.add(tx.id);
      } else {
        carryForward.push(tx.id);
      }
    }

    const removals = [];
    const orphans = [];
    for (const tx of candidates) {
      if (!removalIds.has(tx.id)) continue;
      if (tx.status === 'settled') orphans.push(tx.id);
      else removals.push(tx.id);
    }

    const openDoomedBatches = [];
    const settledDoomedBatches = [];
    for (const batch of this.batches.values()) {
      if (batch.id === savepoint.batchId || !subtree.has(batch.id)) continue;
      if (batch.createdSeq > savepoint.seq && batch.status !== 'rolledback') {
        if (batch.status === 'settled') settledDoomedBatches.push(batch.id);
        else openDoomedBatches.push(batch.id);
      }
    }

    const affectedDays = [
      ...new Set(candidates.filter((tx) => removalIds.has(tx.id)).map((tx) => tx.day)),
    ].sort();
    for (const day of affectedDays) {
      if (this.closedDays.has(day)) {
        throw new LedgerError(ERR.BOUNDARY, `rollback crosses closed day ${day}`, { day });
      }
    }

    if ((orphans.length > 0 || settledDoomedBatches.length > 0) && !reverse) {
      throw new LedgerError(ERR.ORPHAN, 'settled descendants require reversal before rollback', {
        orphans,
        settledBatches: settledDoomedBatches,
      });
    }

    const reversalDay = affectedDays.length > 0 ? affectedDays[affectedDays.length - 1] : savepoint.day;
    const reversals = reverse
      ? orphans.map((id) => {
          const tx = this.txs.get(id);
          return {
            id: `REV-${id}`,
            batchId: tx.batchId,
            account: tx.account,
            amount: -tx.amount,
            day: reversalDay,
            reverses: id,
          };
        })
      : [];

    return {
      savepointId,
      targetBatch: savepoint.batchId,
      reverse,
      affectedRange: {
        fromSeq: savepoint.seq + 1,
        toSeq: this.seq,
        days: affectedDays,
        txCount: removalIds.size,
      },
      removals,
      orphans,
      reversals,
      carryForward,
      removedBatches: [...openDoomedBatches, ...(reverse ? settledDoomedBatches : [])],
      preHash: this.hash(),
    };
  }

  executeRollback(plan) {
    if (!plan || typeof plan !== 'object') {
      throw new LedgerError(ERR.INVAL, 'a rollback plan object is required');
    }
    if (plan.preHash !== this.hash()) {
      throw new LedgerError(ERR.SNAP, 'stale plan: ledger changed since planning');
    }
    for (const id of plan.removals) {
      const tx = this.txs.get(id);
      if (!tx || tx.status === 'void') continue;
      if (tx.status === 'active' || tx.status === 'settled') {
        this._bump(tx.account, -tx.amount);
      }
      tx.status = 'void';
    }
    for (const reversal of plan.reversals) {
      const original = this.txs.get(reversal.reverses);
      if (!original || original.status === 'void') {
        throw new LedgerError(ERR.ORPHAN, `reversal target ${reversal.reverses} not found`);
      }
      if (original.reversedBy) {
        throw new LedgerError(ERR.ORPHAN, `tx ${reversal.reverses} already reversed`);
      }
      this.addTx(reversal);
      original.reversedBy = reversal.id;
    }
    for (const id of plan.removedBatches) {
      const batch = this.batches.get(id);
      if (batch) batch.status = 'rolledback';
    }
    const postHash = this.hash();
    return {
      savepointId: plan.savepointId,
      targetBatch: plan.targetBatch,
      preHash: plan.preHash,
      postHash,
      removedTxs: plan.removals.length,
      reversedTxs: plan.reversals.length,
      carriedForward: plan.carryForward.length,
      removedBatches: plan.removedBatches,
    };
  }

  balances() {
    return Object.fromEntries([...this.balancesMap.entries()].filter(([, v]) => v !== 0));
  }

  hash() {
    const state = {
      seq: this.seq,
      closedDays: [...this.closedDays].sort(),
      batches: [...this.batches.values()]
        .map((b) => ({ id: b.id, parentId: b.parentId, day: b.day, status: b.status }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      txs: this.log
        .filter((tx) => tx.status !== 'void')
        .map((tx) => ({
          id: tx.id,
          batchId: tx.batchId,
          account: tx.account,
          amount: tx.amount,
          day: tx.day,
          status: tx.status,
          corrects: tx.corrects,
          reverses: tx.reverses,
          correctedBy: tx.correctedBy,
          reversedBy: tx.reversedBy,
        })),
    };
    return createHash('sha256').update(stableStringify(state)).digest('hex');
  }

  toJSON() {
    return {
      seq: this.seq,
      batches: [...this.batches.values()],
      txs: this.log,
      savepoints: [...this.savepoints.values()],
      closedDays: [...this.closedDays],
    };
  }

  static fromJSON(data) {
    const ledger = new Ledger();
    ledger.seq = data.seq;
    for (const batch of data.batches) ledger.batches.set(batch.id, batch);
    for (const tx of data.txs) {
      ledger.txs.set(tx.id, tx);
      ledger.log.push(tx);
    }
    for (const savepoint of data.savepoints) ledger.savepoints.set(savepoint.id, savepoint);
    for (const day of data.closedDays) ledger.closedDays.add(day);
    ledger._recomputeBalances();
    return ledger;
  }

  _recomputeBalances() {
    this.balancesMap.clear();
    for (const tx of this.log) {
      if (tx.status === 'void' || tx.status === 'corrected') continue;
      this._bump(tx.account, tx.amount);
    }
  }
}

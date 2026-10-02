'use strict';

const { Store, TxLogError } = require('./store');

function newAccount() {
  return { credit: 0, frozen: 0, position: 0 };
}

function getAccount(state, account) {
  let acc = state.accounts[account];
  if (!acc) {
    acc = newAccount();
    state.accounts[account] = acc;
  }
  return acc;
}

function getTx(state, txId) {
  let tx = state.txs[txId];
  if (!tx) {
    tx = { executed: 0, cancelled: false, buyer: null, seller: null, frozenTotal: 0, qtyTotal: 0 };
    state.txs[txId] = tx;
  }
  return tx;
}

function applyRecord(state, rec) {
  if (!rec || typeof rec !== 'object') {
    throw new TxLogError('USAGE', 'record must be an object');
  }
  if (rec.op === 'put') {
    return applyPut(state, rec);
  }
  if (rec.op === 'cancel') {
    return applyCancel(state, rec);
  }
  throw new TxLogError('USAGE', `unknown op: ${rec.op}`);
}

function applyPut(state, rec) {
  const { txId, buyer, seller, qty, price } = rec;
  if (typeof txId !== 'string' || txId === '') throw new TxLogError('USAGE', 'put requires txId');
  if (typeof buyer !== 'string' || buyer === '') throw new TxLogError('USAGE', 'put requires buyer');
  if (typeof seller !== 'string' || seller === '') throw new TxLogError('USAGE', 'put requires seller');
  if (!Number.isInteger(qty) || qty <= 0) throw new TxLogError('USAGE', 'put qty must be a positive integer');
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new TxLogError('USAGE', 'put price must be a positive number');
  }
  const tx = getTx(state, txId);
  if (tx.cancelled) {
    throw new TxLogError('CONFLICT', `tx ${txId} fully cancelled; further executions rejected`, { txId });
  }
  if (tx.buyer !== null && (tx.buyer !== buyer || tx.seller !== seller)) {
    throw new TxLogError('CONFLICT', `tx ${txId} participants mismatch`, { txId });
  }
  const b = getAccount(state, buyer);
  const s = getAccount(state, seller);
  const cost = qty * price;
  if (b.credit - b.frozen < cost) {
    throw new TxLogError('CONFLICT', `insufficient credit for ${buyer}: need ${cost}, available ${b.credit - b.frozen}`, { txId });
  }
  if (s.position < qty) {
    throw new TxLogError('CONFLICT', `insufficient position for ${seller}: need ${qty}, have ${s.position}`, { txId });
  }
  b.frozen += cost;
  b.position += qty;
  s.position -= qty;
  tx.executed += qty;
  tx.buyer = buyer;
  tx.seller = seller;
  tx.frozenTotal += cost;
  tx.qtyTotal += qty;
  return { txId, executed: tx.executed, frozen: cost };
}

function applyCancel(state, rec) {
  const { txId } = rec;
  if (typeof txId !== 'string' || txId === '') throw new TxLogError('USAGE', 'cancel requires txId');
  const tx = getTx(state, txId);
  if (tx.cancelled) {
    throw new TxLogError('CONFLICT', `tx ${txId} already cancelled`, { txId });
  }
  if (tx.executed <= 0) {
    throw new TxLogError('CONFLICT', `tx ${txId} has no executed quantity to cancel`, { txId });
  }
  tx.cancelled = true;
  return { txId, released: tx.executed };
}

function replayBlocks(state, blocks) {
  const applied = [];
  for (const block of blocks) {
    for (const rec of block.records) {
      applyRecord(state, rec);
      applied.push({ seq: block.seq, op: rec.op, txId: rec.txId });
    }
  }
  return applied;
}

function finalizeState(state) {
  // Void fully cancelled transactions: release the buyer's frozen credit
  // and roll back the positions of both parties.
  for (const tx of Object.values(state.txs)) {
    if (!tx.cancelled) continue;
    const buyer = state.accounts[tx.buyer];
    const seller = state.accounts[tx.seller];
    if (buyer) {
      buyer.frozen -= tx.frozenTotal;
      buyer.position -= tx.qtyTotal;
    }
    if (seller) {
      seller.position += tx.qtyTotal;
    }
  }
  const accounts = {};
  for (const [name, acc] of Object.entries(state.accounts)) {
    accounts[name] = { credit: acc.credit, frozen: acc.frozen, position: acc.position };
  }
  const txs = {};
  for (const [id, tx] of Object.entries(state.txs)) {
    txs[id] = { executed: tx.executed, cancelled: tx.cancelled };
  }
  return { accounts, txs };
}

function emptyState() {
  return { accounts: {}, txs: {} };
}

class Ledger {
  constructor(filePath, accounts) {
    this.store = new Store(filePath);
    this.base = emptyState();
    for (const [name, acc] of Object.entries(accounts || {})) {
      const a = getAccount(this.base, name);
      if (acc.credit !== undefined) a.credit = acc.credit;
      if (acc.position !== undefined) a.position = acc.position;
    }
  }

  _freshState() {
    return JSON.parse(JSON.stringify(this.base));
  }

  put(rec) {
    const state = this._freshState();
    replayBlocks(state, this.store.blocks);
    const info = applyPut(state, rec);
    const { seq } = this.store.append([{ op: 'put', ...rec }]);
    return { seq, ...info };
  }

  cancel(txId) {
    const state = this._freshState();
    replayBlocks(state, this.store.blocks);
    const info = applyCancel(state, { op: 'cancel', txId });
    const { seq } = this.store.append([{ op: 'cancel', txId }]);
    return { seq, ...info };
  }

  replay() {
    const state = this._freshState();
    const applied = replayBlocks(state, this.store.blocks);
    return { blocks: this.store.blocks.length, applied: applied.length, state: finalizeState(state) };
  }

  range(fromSeq, toSeq) {
    const { backfill, indexed, coveredFrom } = this.store.readRange(fromSeq, toSeq);
    const state = this._freshState();
    replayBlocks(state, backfill);
    const applied = replayBlocks(state, indexed);
    return {
      from: fromSeq,
      to: toSeq,
      coveredFrom,
      backfilled: backfill.length,
      applied: applied.length,
      state: finalizeState(state),
    };
  }

  verify() {
    return this.store.verify();
  }
}

module.exports = { Ledger, emptyState, applyRecord, replayBlocks, finalizeState };

import fs from 'node:fs';
import path from 'node:path';
import { Wal, scanBuffer, FRAME_TXN, FRAME_COMMIT } from './wal.js';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// Replays committed transactions from WAL frames into in-memory state,
// including the merchant secondary index. Uncommitted change records
// (a TXN frame with no matching COMMIT) are discarded.
export function buildState(frames) {
  const pending = new Map();
  const txns = new Map();
  const cancelled = new Set();
  const balances = new Map();
  const byMerchant = new Map();

  const applyTxn = (txn) => {
    txns.set(txn.id, txn);
    if (txn.op === 'cancel') cancelled.add(txn.ref);
    balances.set(txn.merchant, (balances.get(txn.merchant) ?? 0) + txn.amount);
    if (!byMerchant.has(txn.merchant)) byMerchant.set(txn.merchant, []);
    byMerchant.get(txn.merchant).push(txn);
  };

  for (const frame of frames) {
    if (frame.type === FRAME_TXN) {
      pending.set(frame.seq, frame.payload);
    } else if (frame.type === FRAME_COMMIT) {
      const txn = pending.get(frame.payload.txSeq);
      if (txn) {
        applyTxn(txn);
        pending.delete(frame.payload.txSeq);
      }
    }
  }
  return { txns, cancelled, balances, byMerchant, discarded: pending.size };
}

export class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.wal = new Wal(this.walPath);
    this.state = null;
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const frames = this.wal.open();
    this.state = buildState(frames);
    return this;
  }

  close() {
    this.wal.close();
  }

  // Commit protocol: append the change record, fsync, then append COMMIT,
  // fsync again, and only then report success to the caller.
  // crashPoint simulates a crash: P1 exits after the change record but
  // before COMMIT; P2 exits after COMMIT but before returning success.
  #commit(record, crashPoint) {
    const txSeq = this.wal.append(FRAME_TXN, record);
    this.wal.fsync();
    if (crashPoint === 'P1') process.exit(3);
    this.wal.append(FRAME_COMMIT, { txSeq });
    this.wal.fsync();
    if (crashPoint === 'P2') process.exit(3);
    return record;
  }

  pay({ id, merchant, amount, crashPoint = null }) {
    if (!id) throw new LedgerError('E_USAGE', 'pay requires a transaction id');
    if (!merchant) throw new LedgerError('E_USAGE', 'pay requires a merchant');
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new LedgerError('E_INVALID_AMOUNT', 'amount must be a positive integer');
    }
    if (this.state.txns.has(id)) {
      throw new LedgerError('E_DUPLICATE_TXN', `transaction ${id} already exists`);
    }
    const record = { op: 'pay', id, merchant, amount, ts: Date.now() };
    const committed = this.#commit(record, crashPoint);
    this.state = buildStateFrom(this.state, committed);
    return committed;
  }

  cancel({ id, crashPoint = null }) {
    if (!id) throw new LedgerError('E_USAGE', 'cancel requires a transaction id');
    const original = this.state.txns.get(id);
    if (!original) {
      throw new LedgerError('E_TXN_NOT_FOUND', `transaction ${id} not found`);
    }
    if (original.op !== 'pay') {
      throw new LedgerError('E_NOT_PAYABLE', `transaction ${id} is not a payment`);
    }
    if (this.state.cancelled.has(id)) {
      throw new LedgerError('E_ALREADY_CANCELLED', `transaction ${id} already cancelled`);
    }
    const record = {
      op: 'cancel',
      id: `cancel:${id}`,
      ref: id,
      merchant: original.merchant,
      amount: -original.amount,
      ts: Date.now(),
    };
    const committed = this.#commit(record, crashPoint);
    this.state = buildStateFrom(this.state, committed);
    return committed;
  }

  audit(merchant) {
    const transactions = this.state.byMerchant.get(merchant) ?? [];
    return {
      merchant,
      balance: this.state.balances.get(merchant) ?? 0,
      transactions,
    };
  }

  // Scans the WAL, truncates any corrupt/truncated tail, and rebuilds
  // state (including the merchant index) purely from committed records.
  recover() {
    this.wal.close();
    const buf = fs.existsSync(this.walPath) ? fs.readFileSync(this.walPath) : Buffer.alloc(0);
    const { frames, validBytes, error } = scanBuffer(buf);
    if (validBytes < buf.length) {
      fs.truncateSync(this.walPath, validBytes);
    }
    this.state = buildState(frames);
    this.wal = new Wal(this.walPath);
    this.wal.open();
    return {
      scannedBytes: buf.length,
      validBytes,
      discardedBytes: buf.length - validBytes,
      corruption: error,
      committedTransactions: this.state.txns.size,
      uncommittedDiscarded: this.state.discarded,
      balances: Object.fromEntries(this.state.balances),
    };
  }
}

function buildStateFrom(state, txn) {
  state.txns.set(txn.id, txn);
  if (txn.op === 'cancel') state.cancelled.add(txn.ref);
  state.balances.set(txn.merchant, (state.balances.get(txn.merchant) ?? 0) + txn.amount);
  if (!state.byMerchant.has(txn.merchant)) state.byMerchant.set(txn.merchant, []);
  state.byMerchant.get(txn.merchant).push(txn);
  return state;
}

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Wal } from './wal.js';
import { Store } from './store.js';

export const DEFAULT_BALANCE = 1000;

export class CrashSimulated extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashSimulated';
    this.point = point;
  }
}

// Idempotent payment service.
//
// Crash points (injectable for testing / CLI):
//   P1: business change written to WAL, before COMMIT  -> rolled back on restart
//   P2: COMMIT durable, before response delivered      -> committed; retry
//        with the same requestId replays the stored first result
export class PaymentService {
  constructor(dir, { crashAt = null } = {}) {
    if (crashAt !== null && crashAt !== 'P1' && crashAt !== 'P2') {
      throw new Error(`unknown crash point: ${crashAt}`);
    }
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.wal = new Wal(join(dir, 'wal.log'));
    this.store = Store.recover(this.wal.all());
    this.crashAt = crashAt;
    this.crashed = false;
  }

  #assertAlive() {
    if (this.crashed) {
      throw new Error('service instance is crashed; create a new instance to restart');
    }
  }

  #crashPoint(point) {
    if (this.crashAt === point) {
      this.crashed = true;
      throw new CrashSimulated(point);
    }
  }

  #nextTxnId() {
    return `tx-${this.store.beginCount + 1}`;
  }

  #runTxn(requestId, op, params, build) {
    const replay = this.store.idem.get(requestId);
    if (replay !== undefined) return replay; // idempotent: first result wins

    const txnId = this.#nextTxnId();
    this.wal.append({ type: 'begin', txnId, requestId, op, params });
    this.store.beginCount += 1;
    if (!this.store.intents.has(requestId)) {
      this.store.intents.set(requestId, { op, params });
    }

    const { result, mutations } = build(txnId);
    mutations.push({ kind: 'putIdem', requestId, result });
    this.wal.append({ type: 'data', txnId, mutations });

    this.#crashPoint('P1'); // business change durable in WAL, not committed

    const seq = this.store.lastSeq + 1;
    this.wal.append({ type: 'commit', txnId, seq });
    this.store.apply(mutations, seq);
    this.store.lastSeq = seq;

    this.#crashPoint('P2'); // committed, response not yet delivered

    return result;
  }

  pay({ requestId, account, amount }) {
    this.#assertAlive();
    return this.#runTxn(requestId, 'pay', { account, amount }, (txnId) => {
      if (!Number.isFinite(amount) || amount <= 0) {
        return {
          result: { ok: false, op: 'pay', requestId, error: 'E_INVALID_AMOUNT', amount },
          mutations: [],
        };
      }
      const balance = this.store.balances.get(account) ?? DEFAULT_BALANCE;
      const txn = {
        txId: txnId, requestId, kind: 'payment', account, amount, status: 'paid',
      };
      return {
        result: {
          ok: true, op: 'pay', requestId, txId: txnId, account, amount,
          balance: balance - amount, status: 'paid',
        },
        mutations: [
          { kind: 'setBalance', account, value: balance - amount },
          { kind: 'putTxn', txId: txnId, txn },
        ],
      };
    });
  }

  cancel({ requestId, txId }) {
    this.#assertAlive();
    return this.#runTxn(requestId, 'cancel', { txId }, (txnId) => {
      const payment = this.store.transactions.get(txId);
      if (!payment || payment.kind !== 'payment') {
        return {
          result: { ok: false, op: 'cancel', requestId, error: 'E_NOT_FOUND', txId },
          mutations: [],
        };
      }
      if (payment.status !== 'paid') {
        return {
          result: {
            ok: false, op: 'cancel', requestId, error: 'E_STATE', txId,
            status: payment.status,
          },
          mutations: [],
        };
      }
      const balance = this.store.balances.get(payment.account) ?? DEFAULT_BALANCE;
      const cancelTxn = {
        txId: txnId, requestId, kind: 'cancel', target: txId,
        account: payment.account, amount: payment.amount, status: 'canceled',
      };
      return {
        result: {
          ok: true, op: 'cancel', requestId, cancelTxId: txnId, txId,
          account: payment.account, refund: payment.amount,
          balance: balance + payment.amount, status: 'canceled',
        },
        mutations: [
          { kind: 'setBalance', account: payment.account, value: balance + payment.amount },
          { kind: 'putTxn', txId, txn: { ...payment, status: 'canceled', canceledBy: txnId } },
          { kind: 'putTxn', txId: txnId, txn: cancelTxn },
        ],
      };
    });
  }

  // Re-drive a requestId after a crash or timeout: committed requests replay
  // their stored result; rolled-back requests re-execute from their intent.
  retry({ requestId }) {
    this.#assertAlive();
    const replay = this.store.idem.get(requestId);
    if (replay !== undefined) return replay;
    const intent = this.store.intents.get(requestId);
    if (!intent) return { ok: false, op: 'retry', requestId, error: 'E_NOT_FOUND' };
    if (intent.op === 'pay') return this.pay({ requestId, ...intent.params });
    return this.cancel({ requestId, ...intent.params });
  }

  getTransaction(txId) {
    this.#assertAlive();
    const txn = this.store.transactions.get(txId);
    if (!txn) return { ok: false, op: 'get', error: 'E_NOT_FOUND', txId };
    return { ok: true, op: 'get', txn };
  }

  getResultByRequestId(requestId) {
    this.#assertAlive();
    const result = this.store.idem.get(requestId);
    if (result === undefined) return { ok: false, op: 'get', error: 'E_NOT_FOUND', requestId };
    return result;
  }

  getBalance(account) {
    this.#assertAlive();
    return {
      ok: true, op: 'get', account,
      balance: this.store.balances.get(account) ?? DEFAULT_BALANCE,
    };
  }

  dumpState(snapshotSeq = Infinity) {
    this.#assertAlive();
    const sort = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    return {
      balances: sort(this.store.balances.snapshot(snapshotSeq)),
      transactions: sort(this.store.transactions.snapshot(snapshotSeq)),
      idem: sort(this.store.idem.snapshot(snapshotSeq)),
      lastSeq: this.store.lastSeq,
    };
  }

  close() {
    this.wal.close();
  }
}

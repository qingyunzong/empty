import { Store } from './store.js';

export const OPENING_BALANCE = 1000;
export const DEFAULT_ACCOUNT = 'main';

export class PayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PayError';
    this.code = code;
  }
}

const accountKey = (account) => `account/${account}`;
const txnKey = (txnId) => `txn/${txnId}`;
const requestKey = (requestId) => `request/${requestId}`;

function requireRequestId(requestId) {
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new PayError('E_INVALID_REQUEST', 'requestId must be a non-empty string');
  }
}

function requireAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PayError('E_INVALID_AMOUNT', 'amount must be a positive integer');
  }
}

// Idempotent payment/cancel service on top of the WAL+MVCC store.
//
// Idempotency: the first committed result for a requestId is stored under
// `request/<requestId>` as part of the same transaction as the business
// change, so a duplicate requestId always returns the first result and never
// repeats the balance mutation. Error outcomes are pure functions of
// committed state and are recomputed deterministically, not stored.
export class PaymentService {
  constructor(store) {
    this.store = store;
  }

  static open(dir) {
    return new PaymentService(Store.open(dir));
  }

  close() {
    this.store.close();
  }

  getBalance(account = DEFAULT_ACCOUNT) {
    const rec = this.store.get(accountKey(account));
    return rec ? rec.balance : OPENING_BALANCE;
  }

  getTransaction(txnId) {
    const txn = this.store.get(txnKey(txnId));
    if (!txn) throw new PayError('E_NOT_FOUND', `unknown transaction ${txnId}`);
    return txn;
  }

  // First committed result for a requestId.
  getRequest(requestId) {
    const rec = this.store.get(requestKey(requestId));
    if (!rec) throw new PayError('E_NOT_FOUND', `unknown request ${requestId}`);
    return rec.result;
  }

  listTransactions() {
    return this.store
      .entries('txn/')
      .map(([, value]) => value)
      .sort((a, b) => a.txnId.localeCompare(b.txnId));
  }

  listRequests() {
    const out = {};
    for (const [key, value] of this.store.entries('request/')) {
      out[key.slice('request/'.length)] = value.result;
    }
    return out;
  }

  pay({ requestId, account = DEFAULT_ACCOUNT, amount }, { crashAt } = {}) {
    requireRequestId(requestId);
    requireAmount(amount);
    const cached = this.store.get(requestKey(requestId));
    if (cached) return cached.result; // duplicate requestId: first result, no re-charge
    const balance = this.getBalance(account);
    if (amount > balance) {
      throw new PayError('E_INSUFFICIENT', `insufficient funds: have ${balance}, need ${amount}`);
    }
    const txnId = this.store.nextTxnId();
    const txn = { txnId, type: 'pay', requestId, account, amount, status: 'PAID' };
    const result = { status: 'ok', type: 'pay', requestId, txnId, account, amount };
    this.store.commit(
      {
        txnId,
        op: 'pay',
        requestId,
        args: { account, amount },
        changes: [
          [accountKey(account), { balance: balance - amount }],
          [txnKey(txnId), txn],
          [requestKey(requestId), { result }],
        ],
      },
      crashAt,
    );
    return result;
  }

  cancel({ requestId, txnId: targetTxnId }, { crashAt } = {}) {
    requireRequestId(requestId);
    const cached = this.store.get(requestKey(requestId));
    if (cached) return cached.result; // duplicate cancel: first cancel result
    const target = this.store.get(txnKey(targetTxnId));
    if (!target) throw new PayError('E_NOT_FOUND', `unknown transaction ${targetTxnId}`);
    if (target.status !== 'PAID') {
      throw new PayError('E_INVALID_STATE', `transaction ${targetTxnId} is ${target.status}, not PAID`);
    }
    const balance = this.getBalance(target.account);
    const txnId = this.store.nextTxnId();
    const txn = {
      txnId,
      type: 'cancel',
      requestId,
      account: target.account,
      amount: target.amount,
      status: 'APPLIED',
      targetTxnId,
    };
    const cancelled = { ...target, status: 'CANCELLED' };
    const result = {
      status: 'ok',
      type: 'cancel',
      requestId,
      txnId,
      targetTxnId,
      account: target.account,
      amount: target.amount,
    };
    this.store.commit(
      {
        txnId,
        op: 'cancel',
        requestId,
        args: { txnId: targetTxnId },
        changes: [
          [accountKey(target.account), { balance: balance + target.amount }],
          [txnKey(targetTxnId), cancelled],
          [txnKey(txnId), txn],
          [requestKey(requestId), { result }],
        ],
      },
      crashAt,
    );
    return result;
  }

  // Re-run the request bound to requestId: returns the committed first result
  // if there is one (P2 crash), re-executes the durable request spec as a new
  // transaction if the original was rolled back (P1 crash).
  retry({ requestId }, { crashAt } = {}) {
    requireRequestId(requestId);
    const cached = this.store.get(requestKey(requestId));
    if (cached) return cached.result;
    const begin = this.store.findBegin(requestId);
    if (!begin) throw new PayError('E_NOT_FOUND', `unknown request ${requestId}`);
    if (begin.op === 'pay') return this.pay({ requestId, ...begin.args }, { crashAt });
    if (begin.op === 'cancel') return this.cancel({ requestId, ...begin.args }, { crashAt });
    throw new PayError('E_INTERNAL', `unknown op ${begin.op}`);
  }
}

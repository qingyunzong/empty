/**
 * Offline account credit/quota ledger.
 *
 * - Accounts have a total credit limit; ACTIVE holds reduce the available
 *   amount; settled payments permanently consume the total; cancelling a
 *   hold restores availability; cancelling a payment issues a refund.
 * - All mutations happen inside transactions with snapshot reads and
 *   optimistic commit validation (account balance version + hold status
 *   version). Conflicts raise E_CONFLICT.
 * - Two secondary indexes, (account,status) and (dueDate,status), are
 *   maintained for holds and become visible atomically with the commit.
 */

export const HOLD_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  SETTLED: 'SETTLED',
});

export const PAYMENT_STATUS = Object.freeze({
  SETTLED: 'SETTLED',
  REFUNDED: 'REFUNDED',
});

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const SEP = '\0';

const keyAccountStatus = (account, status) => `${account}${SEP}${status}`;
const keyDueStatus = (dueDate, status) => `${dueDate}${SEP}${status}`;

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

class Store {
  constructor() {
    this.accounts = new Map(); // id -> {id, total, used, version}
    this.holds = new Map(); // id -> {id, account, amount, dueDate, status, version}
    this.payments = new Map(); // id -> {id, account, holdId, amount, status, version}
    this.refunds = new Map(); // id -> {id, paymentId, account, amount}
    this.seq = 0;
    // Secondary indexes over holds, keyed "<left>\0<status>" -> Set<holdId>.
    this.idxAccountStatus = new Map();
    this.idxDueStatus = new Map();
  }

  snapshot() {
    const snap = new Store();
    snap.accounts = new Map([...this.accounts].map(([k, v]) => [k, clone(v)]));
    snap.holds = new Map([...this.holds].map(([k, v]) => [k, clone(v)]));
    snap.payments = new Map([...this.payments].map(([k, v]) => [k, clone(v)]));
    snap.refunds = new Map([...this.refunds].map(([k, v]) => [k, clone(v)]));
    snap.seq = this.seq;
    return snap;
  }
}

function indexAdd(index, key, id) {
  let bucket = index.get(key);
  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }
  bucket.add(id);
}

function indexRemove(index, key, id) {
  const bucket = index.get(key);
  if (!bucket) return;
  bucket.delete(id);
  if (bucket.size === 0) index.delete(key);
}

function indexHold(store, hold) {
  indexAdd(store.idxAccountStatus, keyAccountStatus(hold.account, hold.status), hold.id);
  indexAdd(store.idxDueStatus, keyDueStatus(hold.dueDate, hold.status), hold.id);
}

function unindexHold(store, hold) {
  indexRemove(store.idxAccountStatus, keyAccountStatus(hold.account, hold.status), hold.id);
  indexRemove(store.idxDueStatus, keyDueStatus(hold.dueDate, hold.status), hold.id);
}

function activeHoldSum(store, accountId) {
  let sum = 0;
  for (const hold of store.holds.values()) {
    if (hold.account === accountId && hold.status === HOLD_STATUS.ACTIVE) sum += hold.amount;
  }
  return sum;
}

export function availableOf(store, account) {
  return account.total - account.used - activeHoldSum(store, account.id);
}

function assertPositiveAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError('E_VALIDATION', `amount must be a positive finite number, got ${amount}`);
  }
}

export class Transaction {
  #ledger;
  #base;
  #readVersions = new Map(); // "kind:id" -> version observed in the snapshot
  #mutations = []; // applied to the live store at commit, in order
  #results = [];
  #done = false;

  constructor(ledger, base) {
    this.#ledger = ledger;
    this.#base = base;
  }

  #track(kind, entity) {
    this.#readVersions.set(`${kind}:${entity.id}`, entity.version);
    return entity;
  }

  #account(id) {
    const account = this.#base.accounts.get(id);
    if (!account) throw new LedgerError('E_NO_ACCOUNT', `unknown account: ${id}`);
    return this.#track('account', account);
  }

  #hold(id) {
    const hold = this.#base.holds.get(id);
    if (!hold) throw new LedgerError('E_NO_HOLD', `unknown hold: ${id}`);
    this.#track('hold', hold);
    this.#track('account', this.#base.accounts.get(hold.account));
    return hold;
  }

  #payment(id) {
    const payment = this.#base.payments.get(id);
    if (!payment) throw new LedgerError('E_NO_PAYMENT', `unknown payment: ${id}`);
    this.#track('payment', payment);
    this.#track('account', this.#base.accounts.get(payment.account));
    return payment;
  }

  #nextId(prefix) {
    this.#base.seq += 1;
    return `${prefix}${this.#base.seq}`;
  }

  /** Freeze part of an account's available credit as a HOLD. */
  freeze({ account, amount, dueDate, holdId }) {
    assertPositiveAmount(amount);
    if (typeof dueDate !== 'string' || dueDate.length === 0) {
      throw new LedgerError('E_VALIDATION', 'dueDate must be a non-empty string');
    }
    const acct = this.#account(account);
    const available = availableOf(this.#base, acct);
    if (amount > available) {
      throw new LedgerError(
        'E_INSUFFICIENT',
        `insufficient available credit on ${account}: need ${amount}, have ${available}`,
      );
    }
    const id = holdId ?? this.#nextId('h');
    if (this.#base.holds.has(id)) throw new LedgerError('E_VALIDATION', `duplicate hold id: ${id}`);
    const hold = { id, account, amount, dueDate, status: HOLD_STATUS.ACTIVE, version: 0 };
    this.#mutations.push((store) => {
      store.holds.set(id, clone(hold));
      indexHold(store, hold);
      store.accounts.get(account).version += 1;
    });
    this.#results.push(clone(hold));
    return clone(hold);
  }

  /** Settle a HOLD: permanently deduct its amount from the account total. */
  pay({ holdId, payId }) {
    const hold = this.#hold(holdId);
    if (hold.status !== HOLD_STATUS.ACTIVE) {
      throw new LedgerError('E_HOLD_NOT_ACTIVE', `hold ${holdId} is ${hold.status}, cannot settle`);
    }
    const id = payId ?? this.#nextId('p');
    if (this.#base.payments.has(id)) throw new LedgerError('E_VALIDATION', `duplicate payment id: ${id}`);
    const payment = {
      id,
      account: hold.account,
      holdId: hold.id,
      amount: hold.amount,
      status: PAYMENT_STATUS.SETTLED,
      version: 0,
    };
    this.#mutations.push((store) => {
      const liveHold = store.holds.get(hold.id);
      unindexHold(store, liveHold);
      liveHold.status = HOLD_STATUS.SETTLED;
      liveHold.version += 1;
      indexHold(store, liveHold);
      const acct = store.accounts.get(hold.account);
      acct.used += hold.amount;
      acct.version += 1;
      store.payments.set(id, clone(payment));
    });
    this.#results.push(clone(payment));
    return clone(payment);
  }

  /** Cancel a HOLD, restoring the account's available credit. */
  release({ holdId }) {
    const hold = this.#hold(holdId);
    if (hold.status !== HOLD_STATUS.ACTIVE) {
      throw new LedgerError('E_HOLD_NOT_ACTIVE', `hold ${holdId} is ${hold.status}, cannot release`);
    }
    this.#mutations.push((store) => {
      const liveHold = store.holds.get(hold.id);
      unindexHold(store, liveHold);
      liveHold.status = HOLD_STATUS.RELEASED;
      liveHold.version += 1;
      indexHold(store, liveHold);
      store.accounts.get(hold.account).version += 1;
    });
    const released = { ...clone(hold), status: HOLD_STATUS.RELEASED };
    this.#results.push(released);
    return clone(released);
  }

  /** Cancel a settled payment, generating a refund that restores total credit. */
  cancelPay({ payId, refundId }) {
    const payment = this.#payment(payId);
    if (payment.status !== PAYMENT_STATUS.SETTLED) {
      throw new LedgerError('E_PAYMENT_NOT_SETTLED', `payment ${payId} is ${payment.status}, cannot refund`);
    }
    const id = refundId ?? this.#nextId('r');
    if (this.#base.refunds.has(id)) throw new LedgerError('E_VALIDATION', `duplicate refund id: ${id}`);
    const refund = { id, paymentId: payment.id, account: payment.account, amount: payment.amount };
    this.#mutations.push((store) => {
      const livePayment = store.payments.get(payment.id);
      livePayment.status = PAYMENT_STATUS.REFUNDED;
      livePayment.version += 1;
      const acct = store.accounts.get(payment.account);
      acct.used -= payment.amount;
      acct.version += 1;
      store.refunds.set(id, clone(refund));
    });
    this.#results.push(clone(refund));
    return clone(refund);
  }

  commit() {
    if (this.#done) throw new LedgerError('E_TX_CLOSED', 'transaction already finished');
    this.#done = true;
    return this.#ledger._commit(this.#readVersions, this.#mutations, this.#results);
  }

  rollback() {
    this.#done = true;
    this.#mutations.length = 0;
    this.#results.length = 0;
  }
}

export class Ledger {
  #store = new Store();

  createAccount({ account, total }) {
    if (typeof account !== 'string' || account.length === 0) {
      throw new LedgerError('E_VALIDATION', 'account id must be a non-empty string');
    }
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
      throw new LedgerError('E_VALIDATION', `total must be a non-negative number, got ${total}`);
    }
    if (this.#store.accounts.has(account)) {
      throw new LedgerError('E_VALIDATION', `duplicate account: ${account}`);
    }
    const acct = { id: account, total, used: 0, version: 0 };
    this.#store.accounts.set(account, acct);
    return clone(acct);
  }

  begin() {
    return new Transaction(this, this.#store.snapshot());
  }

  /** Run fn(tx) in a fresh transaction and commit it. */
  run(fn) {
    const tx = this.begin();
    try {
      const out = fn(tx);
      tx.commit();
      return out;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  _commit(readVersions, mutations, results) {
    // Optimistic validation: every account/hold/payment observed in the
    // snapshot must still carry the same version in the live store.
    for (const [key, version] of readVersions) {
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const table =
        kind === 'account' ? this.#store.accounts : kind === 'hold' ? this.#store.holds : this.#store.payments;
      const live = table.get(id);
      if (!live || live.version !== version) {
        throw new LedgerError('E_CONFLICT', `stale ${kind} ${id}: expected version ${version}`);
      }
    }
    // Apply state mutations and index maintenance in one atomic section:
    // no reader can observe the store between these steps.
    for (const mutate of mutations) mutate(this.#store);
    return results.map(clone);
  }

  account(id) {
    const acct = this.#store.accounts.get(id);
    if (!acct) throw new LedgerError('E_NO_ACCOUNT', `unknown account: ${id}`);
    return { ...clone(acct), available: availableOf(this.#store, acct) };
  }

  hold(id) {
    const h = this.#store.holds.get(id);
    if (!h) throw new LedgerError('E_NO_HOLD', `unknown hold: ${id}`);
    return clone(h);
  }

  payment(id) {
    const p = this.#store.payments.get(id);
    if (!p) throw new LedgerError('E_NO_PAYMENT', `unknown payment: ${id}`);
    return clone(p);
  }

  /** Reference enumeration: full table scan with the same filter semantics. */
  scanHolds({ account, status, dueBefore } = {}) {
    const out = [];
    for (const hold of this.#store.holds.values()) {
      if (account !== undefined && hold.account !== account) continue;
      if (status !== undefined && hold.status !== status) continue;
      if (dueBefore !== undefined && !(hold.dueDate < dueBefore)) continue;
      out.push(clone(hold));
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /**
   * Index-backed hold query. Uses the (account,status) or (dueDate,status)
   * secondary index when the corresponding equality predicates are present,
   * then applies any remaining predicates as a residual filter.
   */
  query({ account, status, dueBefore } = {}) {
    if (account !== undefined && !this.#store.accounts.has(account)) {
      throw new LedgerError('E_NO_ACCOUNT', `unknown account: ${account}`);
    }
    let candidateIds = null;
    if (account !== undefined && status !== undefined) {
      candidateIds = this.#store.idxAccountStatus.get(keyAccountStatus(account, status)) ?? new Set();
    } else if (status !== undefined && dueBefore !== undefined) {
      candidateIds = new Set();
      for (const [key, bucket] of this.#store.idxDueStatus) {
        const sepAt = key.indexOf(SEP);
        const due = key.slice(0, sepAt);
        const st = key.slice(sepAt + 1);
        if (st === status && due < dueBefore) {
          for (const id of bucket) candidateIds.add(id);
        }
      }
    } else if (account !== undefined) {
      candidateIds = new Set();
      for (const [key, bucket] of this.#store.idxAccountStatus) {
        if (key.slice(0, key.indexOf(SEP)) === account) {
          for (const id of bucket) candidateIds.add(id);
        }
      }
    }
    const source =
      candidateIds === null
        ? [...this.#store.holds.values()]
        : [...candidateIds].map((id) => this.#store.holds.get(id));
    const out = source.filter((hold) => {
      if (account !== undefined && hold.account !== account) return false;
      if (status !== undefined && hold.status !== status) return false;
      if (dueBefore !== undefined && !(hold.dueDate < dueBefore)) return false;
      return true;
    });
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out.map(clone);
  }

  /** Test/support hook: expose index internals for consistency checks. */
  _indexes() {
    const dump = (idx) =>
      [...idx.entries()]
        .map(([k, v]) => [k, [...v].sort()])
        .sort(([a], [b]) => (a < b ? -1 : 1));
    return {
      idxAccountStatus: dump(this.#store.idxAccountStatus),
      idxDueStatus: dump(this.#store.idxDueStatus),
    };
  }

  toJSON() {
    return {
      accounts: [...this.#store.accounts.values()].map(clone),
      holds: [...this.#store.holds.values()].map(clone),
      payments: [...this.#store.payments.values()].map(clone),
      refunds: [...this.#store.refunds.values()].map(clone),
      seq: this.#store.seq,
    };
  }

  static fromJSON(data) {
    const ledger = new Ledger();
    for (const a of data.accounts ?? []) ledger.#store.accounts.set(a.id, clone(a));
    for (const h of data.holds ?? []) {
      ledger.#store.holds.set(h.id, clone(h));
      indexHold(ledger.#store, h);
    }
    for (const p of data.payments ?? []) ledger.#store.payments.set(p.id, clone(p));
    for (const r of data.refunds ?? []) ledger.#store.refunds.set(r.id, clone(r));
    ledger.#store.seq = data.seq ?? 0;
    return ledger;
  }
}

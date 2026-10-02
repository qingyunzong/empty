'use strict';

const chain = require('./chain');
const store = require('./store');
const { selectMaxSet } = require('./selection');

class FailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FailError';
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function getAccount(state, id) {
  const account = state.accounts[id];
  if (!account) throw new FailError(`unknown account: ${id}`);
  return account;
}

function getPayment(state, id) {
  const payment = state.payments[id];
  if (!payment) throw new FailError(`unknown payment: ${id}`);
  return payment;
}

// Freezing only affects the available budget; used is touched by settle/refund.
function availableOf(account) {
  return account.budget - account.used - account.frozen;
}

function createAccount(dir, id, budget) {
  const state = store.loadState(dir);
  const existing = state.accounts[id];
  if (existing) {
    if (existing.budget === budget) return { state, created: false };
    throw new UsageError(`account ${id} already exists with a different budget`);
  }
  state.accounts[id] = { budget, frozen: 0, used: 0 };
  store.saveState(dir, state);
  return { state, created: true };
}

function enqueue(dir, accountId, paymentId, amount) {
  const state = store.loadState(dir);
  getAccount(state, accountId);
  const existing = state.payments[paymentId];
  if (existing) {
    if (existing.account !== accountId || existing.amount !== amount) {
      throw new UsageError(`payment ${paymentId} already exists with a different account/amount`);
    }
    if (existing.status === 'queued' || existing.status === 'frozen') {
      return { state, enqueued: false };
    }
    throw new FailError(`payment ${paymentId} already ${existing.status}`);
  }
  state.counter += 1;
  state.payments[paymentId] = {
    account: accountId,
    amount,
    status: 'queued',
    seq: state.counter,
  };
  store.saveState(dir, state);
  return { state, enqueued: true };
}

function freeze(dir, paymentId) {
  const state = store.loadState(dir);
  const payment = getPayment(state, paymentId);
  if (payment.status === 'frozen') return { state, changed: false };
  if (payment.status !== 'queued') {
    throw new FailError(`cannot freeze payment ${paymentId} in status ${payment.status}`);
  }
  const account = getAccount(state, payment.account);
  if (availableOf(account) < payment.amount) {
    throw new FailError(`insufficient available budget in account ${payment.account}`);
  }
  account.frozen += payment.amount;
  payment.status = 'frozen';
  store.saveState(dir, state);
  return { state, changed: true };
}

function cancel(dir, paymentId) {
  const state = store.loadState(dir);
  const payment = getPayment(state, paymentId);
  if (payment.status === 'cancelled') return { state, changed: false };
  if (payment.status === 'settled') {
    throw new FailError(`payment ${paymentId} is settled and cannot be cancelled; use refund`);
  }
  if (payment.status === 'refunded') {
    throw new FailError(`payment ${paymentId} is already refunded`);
  }
  if (payment.status === 'frozen') {
    getAccount(state, payment.account).frozen -= payment.amount;
  }
  payment.status = 'cancelled';
  store.saveState(dir, state);
  return { state, changed: true };
}

function persistBatch(dir, state, body) {
  const record = chain.encodeRecord(body);
  const hash = chain.hashRecord(record);
  state.lastBatch = body.seq;
  state.lastHash = hash;
  store.saveState(dir, state);
  chain.appendRecord(dir, record, { seq: body.seq, hash });
  return hash;
}

function settle(dir) {
  const state = store.loadState(dir);
  const queued = [];
  const frozenPending = [];
  for (const [id, p] of Object.entries(state.payments)) {
    if (p.status === 'queued') queued.push({ id, account: p.account, amount: p.amount });
    else if (p.status === 'frozen') frozenPending.push({ id, account: p.account, amount: p.amount });
  }
  if (queued.length === 0 && frozenPending.length === 0) {
    return { state, batch: null };
  }
  const available = {};
  for (const [id, account] of Object.entries(state.accounts)) {
    available[id] = availableOf(account);
  }
  // Frozen payments are already covered by their reservation; queued payments
  // compete for the remaining available budget.
  const selection = selectMaxSet(queued, available);
  const selectedIds = [...frozenPending.map((p) => p.id), ...selection.selected].sort();
  const rejectedIds = [...selection.rejected].sort();

  const body = {
    seq: state.lastBatch + 1,
    type: 'settle',
    prevHash: state.lastHash,
    selected: selectedIds.map((id) => ({
      id,
      account: state.payments[id].account,
      amount: state.payments[id].amount,
    })),
    rejected: rejectedIds,
  };
  const record = chain.encodeRecord(body);
  const hash = chain.hashRecord(record);

  for (const id of selectedIds) {
    const payment = state.payments[id];
    const account = getAccount(state, payment.account);
    if (payment.status === 'frozen') account.frozen -= payment.amount;
    account.used += payment.amount;
    payment.status = 'settled';
    payment.settledIn = body.seq;
    payment.settledHash = hash;
  }
  state.lastBatch = body.seq;
  state.lastHash = hash;
  store.saveState(dir, state);
  chain.appendRecord(dir, record, { seq: body.seq, hash });
  return { state, batch: { ...body, hash } };
}

function refund(dir, paymentId) {
  const state = store.loadState(dir);
  const payment = getPayment(state, paymentId);
  if (payment.status !== 'settled') {
    throw new FailError(`cannot refund payment ${paymentId} in status ${payment.status}`);
  }
  const body = {
    seq: state.lastBatch + 1,
    type: 'refund',
    prevHash: state.lastHash,
    refHash: payment.settledHash,
    selected: [{ id: paymentId, account: payment.account, amount: payment.amount }],
    rejected: [],
  };
  const account = getAccount(state, payment.account);
  account.used -= payment.amount;
  payment.status = 'refunded';
  payment.refundedIn = body.seq;
  const hash = persistBatch(dir, state, body);
  return { state, batch: { ...body, hash } };
}

module.exports = {
  FailError,
  UsageError,
  availableOf,
  createAccount,
  enqueue,
  freeze,
  cancel,
  settle,
  refund,
};

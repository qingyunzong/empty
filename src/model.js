// Core model: history validation + sequential reservation semantics.
//
// Well-defined edge cases:
//  - Zero amount: reserve(0) always succeeds and holds nothing; commit/cancel
//    of a zero-amount reservation behave normally.
//  - Unknown reserveId: commit/cancel referencing an unknown (or no longer
//    held) reserveId is a failed operation ("fail"); it is NOT an invalid
//    history. A history claiming "ok" for it is simply not linearizable.
//  - Duplicate response: two operations with the same opId are a duplicate
//    response and make the whole history INVALID_HISTORY.
//  - Negative amount or responseTime < invocationTime: INVALID_HISTORY.

export const OP_TYPES = new Set(['reserve', 'commit', 'cancel', 'read']);

export class InvalidHistory extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'InvalidHistory';
    this.code = 'INVALID_HISTORY';
  }
}

function isNonNegNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isId(value) {
  return (typeof value === 'string' && value.length > 0) || typeof value === 'number';
}

export function validateHistory(history) {
  if (!Array.isArray(history)) {
    throw new InvalidHistory('history must be a JSON array of operations');
  }
  const seenOpIds = new Set();
  history.forEach((op, index) => {
    const where = `op[${index}]`;
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new InvalidHistory(`${where}: each operation must be an object`);
    }
    if (typeof op.client !== 'string' || op.client.length === 0) {
      throw new InvalidHistory(`${where}: "client" must be a non-empty string`);
    }
    if (!isId(op.opId)) {
      throw new InvalidHistory(`${where}: "opId" must be a non-empty string or number`);
    }
    if (seenOpIds.has(op.opId)) {
      throw new InvalidHistory(`${where}: duplicate opId ${JSON.stringify(op.opId)} (duplicate response)`);
    }
    seenOpIds.add(op.opId);
    if (!Number.isFinite(op.invocationTime) || !Number.isFinite(op.responseTime)) {
      throw new InvalidHistory(`${where}: "invocationTime"/"responseTime" must be finite numbers`);
    }
    if (op.responseTime < op.invocationTime) {
      throw new InvalidHistory(`${where}: responseTime < invocationTime (time inversion)`);
    }
    if (!OP_TYPES.has(op.type)) {
      throw new InvalidHistory(`${where}: unknown type ${JSON.stringify(op.type)}`);
    }
    if (typeof op.account !== 'string' || op.account.length === 0) {
      throw new InvalidHistory(`${where}: "account" must be a non-empty string`);
    }
    if (op.amount !== undefined && !isNonNegNumber(op.amount)) {
      throw new InvalidHistory(`${where}: "amount" must be a non-negative number`);
    }
    if (op.type === 'reserve') {
      if (!isNonNegNumber(op.amount)) {
        throw new InvalidHistory(`${where}: reserve requires a non-negative "amount"`);
      }
    }
    if (op.type === 'read') {
      if (!isNonNegNumber(op.balance) || !isNonNegNumber(op.frozen)) {
        throw new InvalidHistory(`${where}: read requires observed "balance" and "frozen" (non-negative numbers)`);
      }
    } else {
      if (!isId(op.reserveId)) {
        throw new InvalidHistory(`${where}: "reserveId" must be a non-empty string or number`);
      }
      if (op.status !== undefined && op.status !== 'ok' && op.status !== 'fail') {
        throw new InvalidHistory(`${where}: "status" must be "ok" or "fail"`);
      }
    }
  });
  return history;
}

export function createInitialState(initialBalance = 0) {
  return {
    initialBalance,
    accounts: new Map(),      // account -> { balance, frozen }
    reservations: new Map(),  // reserveId -> { account, amount, status: 'held'|'committed'|'cancelled' }
  };
}

function accountOf(state, account) {
  let acc = state.accounts.get(account);
  if (!acc) {
    acc = { balance: state.initialBalance, frozen: 0 };
    state.accounts.set(account, acc);
  }
  return acc;
}

export function cloneState(state) {
  return {
    initialBalance: state.initialBalance,
    accounts: new Map([...state.accounts].map(([k, v]) => [k, { ...v }])),
    reservations: new Map([...state.reservations].map(([k, v]) => [k, { ...v }])),
  };
}

// Applies one operation to `state` (mutating it) and returns the outcome the
// sequential model would produce: { ok } for mutations, plus the observed
// { balance, frozen } for reads.
export function applyOp(state, op) {
  switch (op.type) {
    case 'reserve': {
      if (state.reservations.has(op.reserveId)) return { ok: false };
      const acc = accountOf(state, op.account);
      if (op.amount > acc.balance) return { ok: false };
      acc.balance -= op.amount;
      acc.frozen += op.amount;
      state.reservations.set(op.reserveId, { account: op.account, amount: op.amount, status: 'held' });
      return { ok: true };
    }
    case 'commit': {
      const res = state.reservations.get(op.reserveId);
      if (!res || res.status !== 'held') return { ok: false };
      const acc = accountOf(state, res.account);
      acc.frozen -= res.amount; // funds leave the account; hold is released
      res.status = 'committed';
      return { ok: true };
    }
    case 'cancel': {
      const res = state.reservations.get(op.reserveId);
      if (!res || res.status !== 'held') return { ok: false };
      const acc = accountOf(state, res.account);
      acc.frozen -= res.amount;
      acc.balance += res.amount; // held funds return to the available balance
      res.status = 'cancelled';
      return { ok: true };
    }
    case 'read': {
      const acc = accountOf(state, op.account);
      return { ok: true, balance: acc.balance, frozen: acc.frozen };
    }
    default:
      throw new Error(`unreachable type ${op.type}`);
  }
}

// Does the recorded response in the history match the model outcome?
export function responseMatches(op, result) {
  if (op.type === 'read') {
    return op.balance === result.balance && op.frozen === result.frozen;
  }
  const expected = op.status ?? 'ok';
  return (result.ok ? 'ok' : 'fail') === expected;
}

export function hashState(state) {
  const acc = [...state.accounts]
    .map(([k, v]) => `${k}:${v.balance},${v.frozen}`)
    .sort()
    .join(';');
  const res = [...state.reservations]
    .map(([k, v]) => `${k}:${v.account},${v.amount},${v.status}`)
    .sort()
    .join(';');
  return `${acc}#${res}`;
}

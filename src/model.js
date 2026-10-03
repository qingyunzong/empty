// Sequential state machine for the trading reservation system.
//
// State per account: { balance, frozen }.
// Reservations: reserveId -> { account, amount, status: 'open' | 'committed' | 'cancelled' }.
//
// Semantics (all defined, including edge cases):
// - reserve(account, amount, reserveId):
//     fails if reserveId already exists or balance < amount.
//     amount === 0 always succeeds (holds nothing, reservation stays open).
//     on success: balance -= amount, frozen += amount, reservation becomes 'open'.
// - commit(reserveId):
//     succeeds exactly once, only while the reservation is 'open'.
//     on success: frozen -= amount (the held funds are consumed), status -> 'committed'.
// - cancel(reserveId):
//     succeeds only while the reservation is 'open'.
//     on success: frozen -= amount, balance += amount (funds returned), status -> 'cancelled'.
// - read(account): always succeeds, returns { balance, frozen } at the linearization point.
// Unknown reserveId for commit/cancel => the operation fails (ok: false).

export function createState(initialBalances = {}) {
  const accounts = new Map();
  for (const [name, balance] of Object.entries(initialBalances)) {
    accounts.set(name, { balance, frozen: 0 });
  }
  return { accounts, reservations: new Map() };
}

export function cloneState(state) {
  const accounts = new Map();
  for (const [name, acc] of state.accounts) {
    accounts.set(name, { balance: acc.balance, frozen: acc.frozen });
  }
  const reservations = new Map();
  for (const [id, r] of state.reservations) {
    reservations.set(id, { account: r.account, amount: r.amount, status: r.status });
  }
  return { accounts, reservations };
}

function getAccount(state, name) {
  let acc = state.accounts.get(name);
  if (!acc) {
    acc = { balance: 0, frozen: 0 };
    state.accounts.set(name, acc);
  }
  return acc;
}

// Applies op to state (mutating) and returns the actual response:
// { ok, result?, failureReason? }.
export function applyOp(state, op) {
  switch (op.type) {
    case 'reserve': {
      const acc = getAccount(state, op.account);
      if (state.reservations.has(op.reserveId)) {
        return { ok: false, failureReason: `reserveId "${op.reserveId}" already exists` };
      }
      if (acc.balance < op.amount) {
        return { ok: false, failureReason: `insufficient balance (${acc.balance} < ${op.amount})` };
      }
      acc.balance -= op.amount;
      acc.frozen += op.amount;
      state.reservations.set(op.reserveId, {
        account: op.account,
        amount: op.amount,
        status: 'open',
      });
      return { ok: true };
    }
    case 'commit': {
      const r = state.reservations.get(op.reserveId);
      if (!r) {
        return { ok: false, failureReason: `unknown reserveId "${op.reserveId}"` };
      }
      if (r.status !== 'open') {
        return { ok: false, failureReason: `reservation "${op.reserveId}" already ${r.status}` };
      }
      const acc = getAccount(state, r.account);
      acc.frozen -= r.amount;
      r.status = 'committed';
      return { ok: true };
    }
    case 'cancel': {
      const r = state.reservations.get(op.reserveId);
      if (!r) {
        return { ok: false, failureReason: `unknown reserveId "${op.reserveId}"` };
      }
      if (r.status !== 'open') {
        return { ok: false, failureReason: `reservation "${op.reserveId}" already ${r.status}` };
      }
      const acc = getAccount(state, r.account);
      acc.frozen -= r.amount;
      acc.balance += r.amount;
      r.status = 'cancelled';
      return { ok: true };
    }
    case 'read': {
      const acc = getAccount(state, op.account);
      return { ok: true, result: { balance: acc.balance, frozen: acc.frozen } };
    }
    default:
      throw new Error(`unknown op type: ${op.type}`);
  }
}

// Does the actual response match the response recorded in the history?
export function responseMatches(actual, recorded) {
  if (actual.ok !== recorded.ok) return false;
  if (recorded.type === 'read') {
    return (
      actual.result.balance === recorded.result.balance &&
      actual.result.frozen === recorded.result.frozen
    );
  }
  return true;
}

export function serializeState(state) {
  const accounts = [...state.accounts.entries()]
    .map(([name, acc]) => `${name}:${acc.balance}/${acc.frozen}`)
    .sort()
    .join(',');
  const reservations = [...state.reservations.entries()]
    .map(([id, r]) => `${id}:${r.account}:${r.amount}:${r.status}`)
    .sort()
    .join(',');
  return `${accounts}|${reservations}`;
}

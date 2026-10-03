import { createHash } from 'node:crypto';

// Canonical JSON with recursively sorted object keys, so that structurally
// equal states always serialize (and hash) identically.
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashState(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function initialState(plan) {
  const balances = {};
  const frozen = {};
  for (const account of plan.accounts) {
    balances[account.id] = account.balance;
    frozen[account.id] = 0;
  }
  return { balances, frozen, holds: {}, frozenAccounts: [], rejected: [] };
}

export function cloneState(state) {
  return structuredClone(state);
}

function reject(state, step, reason) {
  // Business rejections only append a record; the ledger itself is untouched.
  state.rejected.push({ step: step.id, reason });
  return reason;
}

// Applies one step to the state (mutating it). Returns null on success or the
// rejection reason string. Rejected steps never change balances, frozen
// amounts, holds or account-freeze flags.
export function applyStep(state, step) {
  switch (step.type) {
    case 'reserve': {
      const { transfer, from, to, amount } = step;
      if (state.frozenAccounts.includes(from)) {
        return reject(state, step, 'ACCOUNT_FROZEN');
      }
      if (state.holds[transfer]) {
        return reject(state, step, 'HOLD_EXISTS');
      }
      // The availability check looks at the posted balance only; already
      // frozen funds are not subtracted. Whether a plan can over-freeze an
      // account under this rule is exactly what the explorer verifies.
      if (state.balances[from] < amount) {
        return reject(state, step, 'INSUFFICIENT_FUNDS');
      }
      state.frozen[from] += amount;
      state.holds[transfer] = { from, to, amount };
      return null;
    }
    case 'commit': {
      const hold = state.holds[step.transfer];
      if (!hold) {
        return reject(state, step, 'NO_PENDING_HOLD');
      }
      state.balances[hold.from] -= hold.amount;
      state.balances[hold.to] += hold.amount;
      state.frozen[hold.from] -= hold.amount;
      delete state.holds[step.transfer];
      return null;
    }
    case 'cancel': {
      const hold = state.holds[step.transfer];
      if (!hold) {
        return reject(state, step, 'NO_PENDING_HOLD');
      }
      state.frozen[hold.from] -= hold.amount;
      delete state.holds[step.transfer];
      return null;
    }
    case 'freeze': {
      if (!state.frozenAccounts.includes(step.account)) {
        state.frozenAccounts.push(step.account);
        state.frozenAccounts.sort();
      }
      return null;
    }
    default:
      throw new Error(`unknown step type: ${step.type}`);
  }
}

// Safety invariants that must hold after every applied step:
//  - CONSERVATION: total balance across accounts equals the initial total.
//  - NEGATIVE_BALANCE / NEGATIVE_FROZEN: amounts never go below zero.
//  - HOLD_EXCEEDS_AVAILABLE: pending holds (the frozen amount) of an account
//    never exceed its available balance.
//  - HOLD_MISMATCH: frozen amount always equals the sum of pending holds.
export function checkInvariants(state, initialTotal) {
  const violations = [];
  let total = 0;
  for (const id of Object.keys(state.balances)) {
    const balance = state.balances[id];
    const frozenAmount = state.frozen[id];
    total += balance;
    if (balance < 0) {
      violations.push({ type: 'NEGATIVE_BALANCE', account: id, balance });
    }
    if (frozenAmount < 0) {
      violations.push({ type: 'NEGATIVE_FROZEN', account: id, frozen: frozenAmount });
    }
    if (frozenAmount > balance) {
      violations.push({ type: 'HOLD_EXCEEDS_AVAILABLE', account: id, frozen: frozenAmount, balance });
    }
    let held = 0;
    for (const hold of Object.values(state.holds)) {
      if (hold.from === id) held += hold.amount;
    }
    if (held !== frozenAmount) {
      violations.push({ type: 'HOLD_MISMATCH', account: id, held, frozen: frozenAmount });
    }
  }
  if (total !== initialTotal) {
    violations.push({ type: 'CONSERVATION', expected: initialTotal, actual: total });
  }
  return violations;
}

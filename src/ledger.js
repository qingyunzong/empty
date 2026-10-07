// Account operations + undo-chain core library.
// Ops: deposit, withdraw, transfer, freeze, unfreeze, batchBegin, batchEnd, undo.
// Invariants after every applied step: balance>=0, frozen>=0, frozen<=balance, day budget>=0.

export class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const OP_TYPES = new Set(['deposit', 'withdraw', 'transfer', 'freeze', 'unfreeze']);
const INVERSE_TYPE = { deposit: 'withdraw', withdraw: 'deposit', freeze: 'unfreeze', unfreeze: 'freeze' };
const MAX_ENUMERATE = 7; // enumerate inverse-op permutations only up to this size

export function cloneState(state) {
  const accounts = {};
  for (const k of Object.keys(state.accounts)) accounts[k] = { ...state.accounts[k] };
  return { accounts, budget: state.budget };
}

function checkAccount(name, acct) {
  if (acct.balance < 0) throw new LedgerError('INSUFFICIENT', `insufficient balance in account ${name}`);
  if (acct.frozen < 0) throw new LedgerError('INVARIANT', `frozen amount negative in account ${name}`);
  if (acct.frozen > acct.balance) throw new LedgerError('INVARIANT', `frozen exceeds balance in account ${name}`);
}

// Raw effect application without invariant checks.
function applyEffect(state, o) {
  const acct = (name) => {
    if (!state.accounts[name]) state.accounts[name] = { balance: 0, frozen: 0 };
    return state.accounts[name];
  };
  switch (o.type) {
    case 'deposit': acct(o.account).balance += o.amount; break;
    case 'withdraw': acct(o.account).balance -= o.amount; break;
    case 'transfer':
      acct(o.from).balance -= o.amount;
      acct(o.to).balance += o.amount;
      break;
    case 'freeze': acct(o.account).frozen += o.amount; break;
    case 'unfreeze': acct(o.account).frozen -= o.amount; break;
    default: throw new LedgerError('INVALID_INPUT', `unknown op type: ${o.type}`);
  }
  state.budget += (o.budgetDelta ?? 0);
}

// Apply with invariant checks; reverts fully on any violation (atomic step).
export function applyPlanOp(state, o) {
  const touched = [];
  if (o.type === 'transfer') touched.push(o.from, o.to);
  else touched.push(o.account);
  const before = {};
  for (const name of touched) before[name] = state.accounts[name] ? { ...state.accounts[name] } : null;
  const oldBudget = state.budget;
  applyEffect(state, o);
  try {
    for (const name of touched) checkAccount(name, state.accounts[name]);
    if (state.budget < 0) throw new LedgerError('INVARIANT', 'daily budget would become negative');
  } catch (e) {
    for (const name of touched) {
      if (before[name] === null) delete state.accounts[name];
      else state.accounts[name] = before[name];
    }
    state.budget = oldBudget;
    throw e;
  }
}

function validateName(name, field) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new LedgerError('INVALID_INPUT', `invalid account name in field ${field}`);
  }
}

function normalizeUserOp(o, ts) {
  const type = o.op;
  if (!OP_TYPES.has(type)) throw new LedgerError('INVALID_INPUT', `unknown op: ${String(type)}`);
  const amount = o.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError('INVALID_INPUT', `invalid amount: ${String(amount)}`);
  }
  const rec = { type, amount, ts, budgetDelta: 0 };
  if (type === 'transfer') {
    validateName(o.from, 'from');
    validateName(o.to, 'to');
    if (o.from === o.to) throw new LedgerError('INVALID_INPUT', 'transfer from and to must differ');
    rec.from = o.from;
    rec.to = o.to;
    rec.budgetDelta = -amount;
  } else {
    validateName(o.account, 'account');
    rec.account = o.account;
    if (type === 'withdraw') rec.budgetDelta = -amount;
  }
  return rec;
}

export function inverseOf(rec) {
  if (rec.type === 'transfer') {
    return { type: 'transfer', from: rec.to, to: rec.from, amount: rec.amount, ts: rec.ts, budgetDelta: -rec.budgetDelta };
  }
  return { type: INVERSE_TYPE[rec.type], account: rec.account, amount: rec.amount, ts: rec.ts, budgetDelta: -rec.budgetDelta };
}

function serializePlanOp(o) {
  return `${o.type}:${o.account ?? ''}:${o.from ?? ''}:${o.to ?? ''}:${o.amount}:${o.budgetDelta}:${o.ts}`;
}

export function formatPlanOp(o) {
  const out = { op: o.type };
  if (o.account !== undefined) out.account = o.account;
  if (o.from !== undefined) out.from = o.from;
  if (o.to !== undefined) out.to = o.to;
  out.amount = o.amount;
  if (o.budgetDelta) out.budgetDelta = o.budgetDelta;
  out.ts = o.ts;
  return out;
}

export function formatPlan(seq) {
  return seq.map(formatPlanOp);
}

function* permutations(arr) {
  const n = arr.length;
  if (n === 0) { yield []; return; }
  const used = new Array(n).fill(false);
  const cur = [];
  function* rec() {
    if (cur.length === n) { yield cur.slice(); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(arr[i]);
      yield* rec();
      cur.pop();
      used[i] = false;
    }
  }
  yield* rec();
}

function mergeKey(o) {
  return `${o.type}:${o.account ?? ''}:${o.from ?? ''}:${o.to ?? ''}`;
}

// Consolidate inverse ops of the same (type, accounts) into summed ops.
function mergeOps(ops) {
  const map = new Map();
  for (const o of ops) {
    const key = mergeKey(o);
    const cur = map.get(key);
    if (cur) {
      cur.amount += o.amount;
      cur.budgetDelta += o.budgetDelta;
      cur.ts = Math.max(cur.ts, o.ts);
    } else {
      map.set(key, { ...o });
    }
  }
  return [...map.values()].sort((x, y) => (mergeKey(x) < mergeKey(y) ? -1 : 1));
}

function accountsOf(seq) {
  const s = new Set();
  for (const o of seq) {
    if (o.account !== undefined) s.add(o.account);
    if (o.from !== undefined) s.add(o.from);
    if (o.to !== undefined) s.add(o.to);
  }
  return [...s].sort();
}

// Plan ordering: fewest ops, then involved-accounts lexicographic, then event time descending.
export function cmpPlans(p1, p2) {
  if (p1.length !== p2.length) return p1.length - p2.length;
  const a1 = accountsOf(p1);
  const a2 = accountsOf(p2);
  for (let i = 0; i < Math.max(a1.length, a2.length); i++) {
    if (a1[i] === undefined) return -1;
    if (a2[i] === undefined) return 1;
    if (a1[i] !== a2[i]) return a1[i] < a2[i] ? -1 : 1;
  }
  for (let i = 0; i < p1.length; i++) {
    if (p1[i].ts !== p2[i].ts) return p2[i].ts - p1[i].ts;
  }
  return 0;
}

export function statesEqual(a, b) {
  if (a.budget !== b.budget) return false;
  const keys = new Set([...Object.keys(a.accounts), ...Object.keys(b.accounts)]);
  for (const k of keys) {
    const x = a.accounts[k] ?? { balance: 0, frozen: 0 };
    const y = b.accounts[k] ?? { balance: 0, frozen: 0 };
    if (x.balance !== y.balance || x.frozen !== y.frozen) return false;
  }
  return true;
}

export class Ledger {
  constructor({ budget = null } = {}) {
    this.state = { accounts: {}, budget: budget === null ? Infinity : budget };
    this.history = []; // committed units: {id, kind:'op'|'batch', ops:[rec], undone:bool}
    this.openBatch = null;
    this.seq = 0;
    this.batchCounter = 0;
    this.unitCounter = 0;
  }

  getState() {
    return cloneState(this.state);
  }

  #nextTs(o) {
    if (typeof o.ts === 'number' && Number.isFinite(o.ts)) return o.ts;
    return ++this.seq;
  }

  #snapshot() {
    const accounts = {};
    for (const k of Object.keys(this.state.accounts).sort()) {
      const a = this.state.accounts[k];
      accounts[k] = { balance: a.balance, frozen: a.frozen };
    }
    return { accounts, budget: this.state.budget === Infinity ? null : this.state.budget };
  }

  #result(status, extra = {}) {
    return { status, ...extra, state: this.#snapshot(), undoPlan: this.currentUndoPlan() };
  }

  #err(e, input, extra = {}) {
    return {
      status: 'error',
      input,
      error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) },
      ...extra,
      state: this.#snapshot(),
      undoPlan: this.currentUndoPlan(),
    };
  }

  execute(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      return this.#err(new LedgerError('INVALID_INPUT', 'op must be a JSON object'), o);
    }
    try {
      switch (o.op) {
        case 'batchBegin': return this.#batchBegin(o);
        case 'batchEnd': return this.#batchEnd(o);
        case 'undo': return this.#undo(o);
        default: return this.#userOp(o);
      }
    } catch (e) {
      if (e instanceof LedgerError) return this.#err(e, o);
      throw e;
    }
  }

  #userOp(o) {
    const rec = normalizeUserOp(o, this.#nextTs(o));
    if (this.openBatch) {
      const b = this.openBatch;
      if (b.failed) {
        return {
          status: 'skipped',
          input: o,
          error: { code: b.failed.code, message: `batch ${b.id} already failed: ${b.failed.message}` },
          batch: b.id,
          state: this.#snapshot(),
          undoPlan: this.currentUndoPlan(),
        };
      }
      try {
        applyPlanOp(this.state, rec);
      } catch (e) {
        this.state = b.snapshot; // whole batch fails, no partial effect
        b.failed = e;
        return this.#err(e, o, { batch: b.id });
      }
      b.ops.push(rec);
      return this.#result('ok', { input: o, batch: b.id });
    }
    try {
      applyPlanOp(this.state, rec);
    } catch (e) {
      return this.#err(e, o);
    }
    const unit = { id: `U${++this.unitCounter}`, kind: 'op', ops: [rec], undone: false };
    this.history.push(unit);
    return this.#result('ok', { input: o, unit: unit.id });
  }

  #batchBegin(o) {
    if (this.openBatch) {
      return this.#err(new LedgerError('BATCH_NESTING', `batchBegin inside open batch ${this.openBatch.id}`), o);
    }
    const id = o.id ?? `B${++this.batchCounter}`;
    this.openBatch = { id, ops: [], snapshot: cloneState(this.state), failed: null };
    return this.#result('ok', { input: o, batch: id });
  }

  #batchEnd(o) {
    const b = this.openBatch;
    if (!b) return this.#err(new LedgerError('BATCH_NESTING', 'batchEnd without batchBegin'), o);
    this.openBatch = null;
    if (b.failed) {
      return this.#err(new LedgerError(b.failed.code, `batch ${b.id} rolled back: ${b.failed.message}`), o, { batch: b.id });
    }
    const unit = { id: b.id, kind: 'batch', ops: b.ops, undone: false };
    this.history.push(unit);
    return this.#result('ok', { input: o, batch: b.id, committed: b.ops.length });
  }

  #undo(o) {
    if (this.openBatch) {
      return this.#err(new LedgerError('BATCH_NESTING', `undo inside open batch ${this.openBatch.id} not allowed`), o);
    }
    let unit = null;
    if (o.batch !== undefined) {
      unit = this.history.find((u) => u.kind === 'batch' && u.id === o.batch && !u.undone) ?? null;
      if (!unit) return this.#err(new LedgerError('UNDO_GAP', `no committed undoable batch ${String(o.batch)}`), o);
    } else {
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (!this.history[i].undone) { unit = this.history[i]; break; }
      }
      if (!unit) return this.#err(new LedgerError('UNDO_GAP', 'nothing to undo'), o);
    }
    const { best, tied } = this.computePlans(unit);
    if (!best) {
      return this.#err(new LedgerError('INVARIANT', `no legal undo plan for ${unit.id}`), o);
    }
    if (tied.length > 1) {
      return this.#err(
        new LedgerError('AMBIGUOUS_UNDO', `${tied.length} equally preferred undo plans for ${unit.id}`, {
          plans: tied.map(formatPlan),
        }),
        o,
      );
    }
    for (const po of best) applyPlanOp(this.state, po);
    unit.undone = true;
    return {
      status: 'ok',
      input: o,
      undone: unit.id,
      undoPlan: { target: unit.id, status: 'EXECUTED', ops: formatPlan(best) },
      state: this.#snapshot(),
    };
  }

  // All legal undo plans for a unit against the CURRENT state (cross-batch expansion),
  // sorted by the deterministic preference order. Ties share the best rank.
  computePlans(unit) {
    const inverses = unit.ops.map(inverseOf);
    const expected = cloneState(this.state);
    for (const rec of unit.ops) applyEffect(expected, inverseOf(rec)); // current minus unit effect
    const seen = new Set();
    const valid = [];
    const consider = (seq) => {
      const key = seq.map(serializePlanOp).join('|');
      if (seen.has(key)) return;
      seen.add(key);
      const sim = cloneState(this.state);
      for (const po of seq) {
        try {
          applyPlanOp(sim, po);
        } catch {
          return;
        }
      }
      if (statesEqual(sim, expected)) valid.push(seq);
    };
    if (inverses.length <= MAX_ENUMERATE) {
      for (const p of permutations(inverses)) consider(p);
    } else {
      consider([...inverses].reverse());
    }
    const merged = mergeOps(inverses);
    if (merged.length !== inverses.length) {
      if (merged.length <= MAX_ENUMERATE) {
        for (const p of permutations(merged)) consider(p);
      } else {
        consider(merged);
      }
    }
    valid.sort(cmpPlans);
    const tied = valid.length > 0 ? valid.filter((p) => cmpPlans(p, valid[0]) === 0) : [];
    return { best: valid[0] ?? null, tied, all: valid };
  }

  #topUnit() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (!this.history[i].undone) return this.history[i];
    }
    return null;
  }

  currentUndoPlan() {
    const unit = this.#topUnit();
    if (!unit) return null;
    const { best, tied } = this.computePlans(unit);
    if (!best) return { target: unit.id, status: 'NO_LEGAL_PLAN', ops: [] };
    if (tied.length > 1) return { target: unit.id, status: 'AMBIGUOUS', candidates: tied.map(formatPlan) };
    return { target: unit.id, status: 'OK', ops: formatPlan(best) };
  }
}

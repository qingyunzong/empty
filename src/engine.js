'use strict';

// Account operations & undo-chain engine.
//
// Semantics (see README.md):
// - Ops: deposit, withdraw, transfer, freeze, unfreeze, batchBegin, batchEnd, undo.
// - Every committed money op records an inverse op. Committed units (a standalone
//   op or a committed batch) are pushed on the undo stack.
// - undo pops the top unit, or a specified committed batch by id; cross-batch undo
//   expands to the region [target .. top] and is planned as one deterministic
//   sequence of inverse ops.
// - Invariants: balance >= 0, frozen >= 0, frozen <= balance, day budget >= 0.
//   Any violation inside a batch aborts the whole batch with no partial effect.
// - Undo plans: all legal orderings of the region's inverse ops (an ordering is
//   legal when every prefix state satisfies the invariants). Plans are ranked by
//   (1) fewest ops, (2) involved accounts lexicographic, (3) original event time
//   descending (undoing more recent events first). A tie yields AMBIGUOUS_UNDO.

const MAX_ENUM = 8; // max inverse ops for full permutation search

const ERR = {
  INSUFFICIENT: 'INSUFFICIENT',
  BATCH_NESTING: 'BATCH_NESTING',
  UNDO_GAP: 'UNDO_GAP',
  AMBIGUOUS_UNDO: 'AMBIGUOUS_UNDO',
  INVARIANT: 'INVARIANT',
  INVALID: 'INVALID',
};

function fail(code, message) {
  return { code, message };
}

function getAccount(accounts, name) {
  let a = accounts[name];
  if (!a) {
    a = { balance: 0, frozen: 0 };
    accounts[name] = a;
  }
  return a;
}

// Removes an account once it carries no funds, so states stay canonical
// (an account at 0/0 is indistinguishable from a never-touched one).
function pruneAccount(accounts, name) {
  const a = accounts[name];
  if (a && a.balance === 0 && a.frozen === 0) delete accounts[name];
}

function touchedAccounts(op) {
  if (op.account !== undefined) return [op.account];
  return [op.from, op.to];
}

// Applies a money-moving op to (accounts, budget). budgetSign: -1 consumes
// budget (normal op), +1 refunds (inverse op during undo). Returns null on
// success or an error code. Callers apply to a trial copy.
function applyMoneyEffect(accounts, budget, op, budgetSign) {
  switch (op.op) {
    case 'deposit': {
      getAccount(accounts, op.account).balance += op.amount;
      if (budget) budget.day += budgetSign * op.amount;
      return null;
    }
    case 'withdraw': {
      const a = getAccount(accounts, op.account);
      if (a.balance - a.frozen < op.amount) return ERR.INSUFFICIENT;
      a.balance -= op.amount;
      if (budget) budget.day += budgetSign * op.amount;
      return null;
    }
    case 'transfer': {
      const from = getAccount(accounts, op.from);
      if (from.balance - from.frozen < op.amount) return ERR.INSUFFICIENT;
      from.balance -= op.amount;
      getAccount(accounts, op.to).balance += op.amount;
      if (budget) budget.day += budgetSign * op.amount;
      return null;
    }
    case 'freeze': {
      const a = getAccount(accounts, op.account);
      if (a.balance - a.frozen < op.amount) return ERR.INSUFFICIENT;
      a.frozen += op.amount;
      return null;
    }
    case 'unfreeze': {
      const a = getAccount(accounts, op.account);
      if (a.frozen < op.amount) return ERR.INSUFFICIENT;
      a.frozen -= op.amount;
      return null;
    }
    default:
      return ERR.INVALID;
  }
}

function checkInvariants(accounts, budget) {
  for (const name of Object.keys(accounts)) {
    const a = accounts[name];
    if (a.balance < 0 || a.frozen < 0 || a.frozen > a.balance) return false;
  }
  if (budget && budget.day < 0) return false;
  return true;
}

function inverseOf(op) {
  switch (op.op) {
    case 'deposit':
      return { op: 'withdraw', account: op.account, amount: op.amount };
    case 'withdraw':
      return { op: 'deposit', account: op.account, amount: op.amount };
    case 'transfer':
      return { op: 'transfer', from: op.to, to: op.from, amount: op.amount };
    case 'freeze':
      return { op: 'unfreeze', account: op.account, amount: op.amount };
    case 'unfreeze':
      return { op: 'freeze', account: op.account, amount: op.amount };
    default:
      return null;
  }
}

const MONEY_OPS = new Set(['deposit', 'withdraw', 'transfer', 'freeze', 'unfreeze']);

function isValidAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail(ERR.INVALID, 'op must be a JSON object');
  }
  const op = input.op;
  if (MONEY_OPS.has(op)) {
    if (!isValidAmount(input.amount)) return fail(ERR.INVALID, op + ': amount must be a number >= 0');
    if (op === 'transfer') {
      if (typeof input.from !== 'string' || typeof input.to !== 'string') {
        return fail(ERR.INVALID, 'transfer: from/to must be strings');
      }
      if (input.from === input.to) return fail(ERR.INVALID, 'transfer: from and to must differ');
    } else if (typeof input.account !== 'string') {
      return fail(ERR.INVALID, op + ': account must be a string');
    }
    return null;
  }
  if (op === 'batchBegin' || op === 'batchEnd') {
    if (input.id !== undefined && typeof input.id !== 'string') return fail(ERR.INVALID, op + ': id must be a string');
    return null;
  }
  if (op === 'undo') {
    if (input.batch !== undefined && typeof input.batch !== 'string') return fail(ERR.INVALID, 'undo: batch must be a string');
    return null;
  }
  return fail(ERR.INVALID, 'unknown op: ' + String(op));
}

// --- undo planning ---------------------------------------------------------

function planAccountsKey(plan) {
  const set = new Set();
  for (const s of plan) {
    if (s.account !== undefined) set.add(s.account);
    if (s.from !== undefined) set.add(s.from);
    if (s.to !== undefined) set.add(s.to);
  }
  return [...set].sort().join(',');
}

// negative => a preferred over b
function comparePlans(a, b) {
  if (a.length !== b.length) return a.length - b.length; // fewest ops
  const ka = planAccountsKey(a);
  const kb = planAccountsKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1; // accounts lexicographic
  for (let i = 0; i < a.length; i++) {
    if (a[i].event !== b[i].event) return b[i].event - a[i].event; // event time descending
  }
  return 0;
}

function serializePlan(plan) {
  return plan
    .map((s) => {
      const who = s.account !== undefined ? s.account : s.from + '>' + s.to;
      return s.op + ':' + who + ':' + s.amount;
    })
    .join('|');
}

// Enumerates every legal ordering of the inverse ops (each prefix state must
// satisfy the invariants). Reverse commit order is always legal, so the result
// is never empty. Regions larger than MAX_ENUM fall back to the single
// canonical reverse-commit-order plan.
function buildPlans(accounts, budget, regionOps) {
  const required = [];
  for (const ro of regionOps) {
    if (ro.inverse.amount === 0) continue; // no-op inverse, dropped
    required.push({ ...ro.inverse, event: ro.event });
  }
  if (required.length === 0) return [[]];
  if (required.length > MAX_ENUM) return [[...required].reverse()];

  const plans = [];
  const seen = new Set();
  const used = new Array(required.length).fill(false);
  const current = [];

  function dfs(accountsNow, budgetNow) {
    if (current.length === required.length) {
      const key = serializePlan(current);
      if (!seen.has(key)) {
        seen.add(key);
        plans.push(current.map((s) => ({ ...s })));
      }
      return;
    }
    for (let i = 0; i < required.length; i++) {
      if (used[i]) continue;
      const step = required[i];
      const trialAccounts = structuredClone(accountsNow);
      const trialBudget = budgetNow ? { ...budgetNow } : null;
      const err = applyMoneyEffect(trialAccounts, trialBudget, step, +1);
      if (err || !checkInvariants(trialAccounts, trialBudget)) continue;
      used[i] = true;
      current.push(step);
      dfs(trialAccounts, trialBudget);
      current.pop();
      used[i] = false;
    }
  }

  dfs(structuredClone(accounts), budget ? { ...budget } : null);
  return plans;
}

// Returns { best, tied } — tied contains every plan equal to best under the
// ranking comparator (after dedup, ties mean genuine ambiguity).
function rankPlans(plans) {
  const sorted = [...plans].sort(comparePlans);
  const best = sorted[0];
  const tied = sorted.filter((p) => comparePlans(p, best) === 0);
  return { best, tied };
}

function formatPlan(plan) {
  return plan.map((s) => {
    const out = { op: s.op, amount: s.amount, event: s.event };
    if (s.account !== undefined) out.account = s.account;
    if (s.from !== undefined) {
      out.from = s.from;
      out.to = s.to;
    }
    return out;
  });
}

// --- engine ----------------------------------------------------------------

class Engine {
  constructor(options = {}) {
    this.accounts = {};
    this.budget = options.budget ? { day: options.budget.day } : null;
    this.stack = []; // committed units: { id, event, ops: [{...op, inverse}] }
    this.eventSeq = 0;
    this.batch = null; // { id, ops, snapshot }
    this.autoBatchSeq = 0;
  }

  snapshotState() {
    return {
      accounts: structuredClone(this.accounts),
      budget: this.budget ? { ...this.budget } : null,
    };
  }

  restoreState(snapshot) {
    this.accounts = snapshot.accounts;
    this.budget = snapshot.budget;
  }

  apply(input) {
    const result = { input, status: 'ok', error: null, undoPlan: null };
    const err = this.dispatch(input, result);
    if (err) {
      result.status = 'error';
      result.error = err;
    }
    result.state = this.snapshotState();
    result.undoDepth = this.stack.length;
    return result;
  }

  dispatch(input, result) {
    const invalid = validate(input);
    if (invalid) return invalid;
    switch (input.op) {
      case 'batchBegin':
        return this.batchBegin(input);
      case 'batchEnd':
        return this.batchEnd(input);
      case 'undo':
        return this.undo(input, result);
      default:
        return this.moneyOp(input);
    }
  }

  batchBegin(input) {
    if (this.batch) {
      return fail(ERR.BATCH_NESTING, 'batchBegin inside open batch ' + this.batch.id + '; outer batch continues');
    }
    const id = input.id !== undefined ? input.id : 'b' + ++this.autoBatchSeq;
    this.batch = { id, ops: [], snapshot: this.snapshotState() };
    return null;
  }

  batchEnd(input) {
    if (!this.batch) return fail(ERR.BATCH_NESTING, 'batchEnd without batchBegin');
    if (input.id !== undefined && input.id !== this.batch.id) {
      return fail(ERR.BATCH_NESTING, 'batchEnd id ' + input.id + ' does not match open batch ' + this.batch.id);
    }
    const batch = this.batch;
    this.batch = null;
    this.eventSeq++;
    this.stack.push({ id: batch.id, event: this.eventSeq, ops: batch.ops });
    return null;
  }

  moneyOp(op) {
    const trial = this.snapshotState();
    const effectErr = applyMoneyEffect(trial.accounts, trial.budget, op, -1);
    const code = effectErr || (checkInvariants(trial.accounts, trial.budget) ? null : ERR.INVARIANT);
    if (code) {
      if (this.batch) {
        const abortedId = this.batch.id;
        this.restoreState(this.batch.snapshot);
        this.batch = null;
        return fail(code, 'batch ' + abortedId + ' aborted and rolled back (' + code + ')');
      }
      return fail(code, op.op + ' rejected (' + code + ')');
    }
    this.accounts = trial.accounts;
    this.budget = trial.budget;
    for (const name of touchedAccounts(op)) pruneAccount(this.accounts, name);
    const recorded = { ...op, inverse: inverseOf(op) };
    if (this.batch) {
      this.batch.ops.push(recorded);
    } else {
      this.eventSeq++;
      this.stack.push({ id: 'u' + this.eventSeq, event: this.eventSeq, ops: [recorded] });
    }
    return null;
  }

  undo(input, result) {
    if (this.batch) return fail(ERR.BATCH_NESTING, 'undo inside open batch ' + this.batch.id);
    if (this.stack.length === 0) return fail(ERR.UNDO_GAP, 'undo stack is empty');
    let idx;
    if (input.batch !== undefined) {
      idx = -1;
      for (let i = this.stack.length - 1; i >= 0; i--) {
        if (this.stack[i].id === input.batch) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return fail(ERR.UNDO_GAP, 'batch ' + input.batch + ' not found or already undone');
    } else {
      idx = this.stack.length - 1;
    }
    const region = this.stack.slice(idx);
    const regionOps = [];
    for (const unit of region) {
      for (const op of unit.ops) regionOps.push({ inverse: op.inverse, event: unit.event });
    }
    const plans = buildPlans(this.accounts, this.budget, regionOps);
    const { tied } = rankPlans(plans);
    const target = region[0].id;
    if (tied.length > 1) {
      result.undoPlan = {
        target,
        ambiguous: true,
        candidates: tied.map(formatPlan),
      };
      return fail(ERR.AMBIGUOUS_UNDO, tied.length + ' equally preferred undo plans for ' + target);
    }
    const chosen = tied[0];
    for (const step of chosen) {
      applyMoneyEffect(this.accounts, this.budget, step, +1); // guaranteed legal
    }
    for (const step of chosen) {
      for (const name of touchedAccounts(step)) pruneAccount(this.accounts, name);
    }
    this.stack.length = idx; // pop the whole region
    result.undoPlan = { target, steps: formatPlan(chosen) };
    return null;
  }
}

module.exports = {
  Engine,
  ERR,
  comparePlans,
  buildPlans,
  rankPlans,
  inverseOf,
  checkInvariants,
  applyMoneyEffect,
};

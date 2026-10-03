// Core library for the end-of-day clearing serializability judge.
//
// Semantics (per account): state = { available, frozen, hasFreeze }.
//   FREEZE  a : requires available >= a; available -= a; frozen += a; hasFreeze = true
//   DEBIT   a : requires frozen    >= a; frozen -= a            (debit against the hold)
//   RELEASE a : requires frozen    >= a; frozen -= a; available += a
//   SETTLE  a : requires hasFreeze && frozen >= a; frozen -= a  (settle a prior freeze)
// "available" must never go negative; "frozen" must never go negative.
//
// Order constraints:
//   depends: every opId in cmd.depends must be scheduled before cmd.
//   intervals: a must precede b iff a.end <= b.start && !(b.end <= a.start)
//              (disjoint intervals keep time order; equal instant points are unordered).

export const EXIT_INTERVAL = 12;
export const EXIT_CYCLE = 13;
export const EXIT_UNKNOWN = 14;

export class JudgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JudgeError';
    this.code = code;
  }
}

export const ACTIONS = new Set(['FREEZE', 'DEBIT', 'RELEASE', 'SETTLE']);

function fail(code, msg) {
  throw new JudgeError(code, msg);
}

function normalizeCommand(raw, lineNo) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(EXIT_UNKNOWN, `line ${lineNo}: command is not a JSON object`);
  }
  const where = `line ${lineNo}`;
  if (raw.opId === undefined || raw.opId === null || raw.opId === '') {
    fail(EXIT_UNKNOWN, `${where}: missing opId`);
  }
  const opId = String(raw.opId);
  if (!ACTIONS.has(raw.action)) {
    fail(EXIT_UNKNOWN, `${where}: unknown action ${JSON.stringify(raw.action)}`);
  }
  if (typeof raw.account !== 'string' || raw.account === '') {
    fail(EXIT_UNKNOWN, `${where}: missing account`);
  }
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0) {
    fail(EXIT_UNKNOWN, `${where}: amount must be a positive finite number`);
  }
  if (
    typeof raw.start !== 'number' || !Number.isFinite(raw.start) ||
    typeof raw.end !== 'number' || !Number.isFinite(raw.end) ||
    raw.start > raw.end
  ) {
    fail(EXIT_INTERVAL, `${where}: invalid interval [${raw.start}, ${raw.end}]`);
  }
  let depends = raw.depends === undefined ? [] : raw.depends;
  if (!Array.isArray(depends) || depends.some((d) => d === null || d === undefined || d === '')) {
    fail(EXIT_UNKNOWN, `${where}: depends must be an array of opIds`);
  }
  depends = depends.map(String);
  let balance;
  if (raw.balance !== undefined) {
    if (typeof raw.balance !== 'number' || !Number.isFinite(raw.balance) || raw.balance < 0) {
      fail(EXIT_UNKNOWN, `${where}: balance must be a non-negative finite number`);
    }
    balance = raw.balance;
  }
  return {
    opId,
    session: raw.session === undefined ? null : raw.session,
    start: raw.start,
    end: raw.end,
    action: raw.action,
    account: raw.account,
    amount: raw.amount,
    depends,
    balance,
  };
}

function assertNoDependsCycle(commands) {
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const state = new Map(); // 0=unvisited 1=in-stack 2=done
  const stack = [];
  const visit = (id) => {
    const s = state.get(id) || 0;
    if (s === 2) return;
    if (s === 1) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      fail(EXIT_CYCLE, `depends cycle: ${cycle.join(' -> ')}`);
    }
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id).depends) visit(d);
    stack.pop();
    state.set(id, 2);
  };
  for (const c of commands) visit(c.opId);
}

// Parse JSONL text into normalized commands; throws JudgeError with exit codes.
export function parseHistory(text) {
  const commands = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      fail(EXIT_UNKNOWN, `line ${i + 1}: invalid JSON`);
    }
    commands.push(normalizeCommand(raw, i + 1));
  }
  const seen = new Set();
  for (const c of commands) {
    if (seen.has(c.opId)) fail(EXIT_UNKNOWN, `duplicate opId ${JSON.stringify(c.opId)}`);
    seen.add(c.opId);
  }
  for (const c of commands) {
    for (const d of c.depends) {
      if (!seen.has(d)) {
        fail(EXIT_UNKNOWN, `command ${c.opId}: unknown depends opId ${JSON.stringify(d)}`);
      }
    }
  }
  assertNoDependsCycle(commands);
  return commands;
}

const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Predecessor map: opId -> Set of opIds that must be scheduled earlier.
export function buildPredecessors(commands) {
  const preds = new Map(commands.map((c) => [c.opId, new Set()]));
  const byId = new Map(commands.map((c) => [c.opId, c]));
  for (const c of commands) {
    for (const d of c.depends) {
      if (byId.has(d)) preds.get(c.opId).add(d);
    }
  }
  for (const a of commands) {
    for (const b of commands) {
      if (a === b) continue;
      if (a.end <= b.start && !(b.end <= a.start)) preds.get(b.opId).add(a.opId);
    }
  }
  return preds;
}

// Initial available balance per account: first `balance` declaration in
// file order wins; accounts without a declaration start at 0.
export function accountBalances(commands) {
  const balances = new Map();
  for (const c of commands) {
    if (c.balance !== undefined && !balances.has(c.account)) {
      balances.set(c.account, c.balance);
    }
  }
  return balances;
}

export function initialAccounts(commands, balances = accountBalances(commands)) {
  const accounts = new Map();
  for (const c of commands) {
    if (!accounts.has(c.account)) {
      accounts.set(c.account, {
        available: balances.get(c.account) ?? 0,
        frozen: 0,
        hasFreeze: false,
      });
    }
  }
  return accounts;
}

function canApply(acc, cmd) {
  switch (cmd.action) {
    case 'FREEZE':
      return acc.available >= cmd.amount;
    case 'DEBIT':
      return acc.frozen >= cmd.amount;
    case 'RELEASE':
      return acc.frozen >= cmd.amount;
    case 'SETTLE':
      return acc.hasFreeze && acc.frozen >= cmd.amount;
    default:
      return false;
  }
}

function apply(acc, cmd) {
  const snap = { ...acc };
  switch (cmd.action) {
    case 'FREEZE':
      acc.available -= cmd.amount;
      acc.frozen += cmd.amount;
      acc.hasFreeze = true;
      break;
    case 'DEBIT':
      acc.frozen -= cmd.amount;
      break;
    case 'RELEASE':
      acc.frozen -= cmd.amount;
      acc.available += cmd.amount;
      break;
    case 'SETTLE':
      acc.frozen -= cmd.amount;
      break;
  }
  return snap;
}

function restore(acc, snap) {
  Object.assign(acc, snap);
}

// Lexicographically smallest valid serial order (array of opIds), or null.
// `balances` optionally overrides the initial available per account; this is
// used when judging a subset in the context of the full history.
export function solve(commands, balances = accountBalances(commands)) {
  const preds = buildPredecessors(commands);
  const sorted = [...commands].sort((a, b) => cmpId(a.opId, b.opId));
  const accounts = initialAccounts(commands, balances);
  const done = new Set();
  const order = [];
  const dfs = () => {
    if (order.length === commands.length) return true;
    for (const c of sorted) {
      if (done.has(c.opId)) continue;
      let ready = true;
      for (const p of preds.get(c.opId)) {
        if (!done.has(p)) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;
      const acc = accounts.get(c.account);
      if (!canApply(acc, c)) continue;
      const snap = apply(acc, c);
      done.add(c.opId);
      order.push(c.opId);
      if (dfs()) return true;
      restore(acc, snap);
      done.delete(c.opId);
      order.pop();
    }
    return false;
  };
  return dfs() ? [...order] : null;
}

function* combinations(items, k) {
  const n = items.length;
  if (k < 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Minimum-cardinality UNSAT subset; ties broken by lexicographic order of the
// sorted opId tuple. Depends edges pointing outside the subset are dropped.
// Subsets are judged against the initial balances declared in the FULL
// history, so the conflict explains infeasibility under the same account
// conditions.
export function minimalConflict(commands) {
  const balances = accountBalances(commands);
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const ids = [...byId.keys()].sort(cmpId);
  for (let k = 1; k <= ids.length; k++) {
    for (const combo of combinations(ids, k)) {
      const members = new Set(combo);
      const subset = combo.map((id) => {
        const c = byId.get(id);
        return { ...c, depends: c.depends.filter((d) => members.has(d)) };
      });
      if (solve(subset, balances) === null) return combo;
    }
  }
  return null;
}

export function judge(commands) {
  const witness = solve(commands);
  if (witness !== null) return { result: 'SAT', witness };
  return { result: 'UNSAT', conflict: minimalConflict(commands) };
}

// --- Independent brute-force reference (n <= 8): enumerate all permutations ---

function* permutations(items) {
  if (items.length === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

function isValidOrder(perm, byId, preds, accounts) {
  const done = new Set();
  for (const id of perm) {
    const cmd = byId.get(id);
    for (const p of preds.get(id)) {
      if (!done.has(p)) return false;
    }
    const acc = accounts.get(cmd.account);
    if (!canApply(acc, cmd)) return false;
    apply(acc, cmd);
    done.add(id);
  }
  return true;
}

// Returns the lexicographically smallest valid permutation, or null.
export function bruteForce(commands, balances = accountBalances(commands)) {
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const ids = [...byId.keys()].sort(cmpId);
  const preds = buildPredecessors(commands);
  for (const perm of permutations(ids)) {
    const accounts = initialAccounts(commands, balances);
    if (isValidOrder(perm, byId, preds, accounts)) return perm;
  }
  return null;
}

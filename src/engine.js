// Core domain logic: settlement accounts, payments, reversals, risk flags,
// and the online-built unique (riskFlag, account) secondary index.
// Pure functions over an immutable-ish state object (structuredClone per tx).

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new DomainError(code, message); };

export function initialState() {
  return {
    seq: 0,
    version: 0,
    accounts: {},          // id -> { balance, riskFlag, flagVersion }
    payments: {},          // id -> { account, amount, version, reversed, reverseVersion }
    history: [],           // [{ version, ops }] committed tx log for snapshot scans
    index: { state: 'none', watermark: null, entries: {} }, // entries: "flag\0account" -> [{begin,end}]
    backfill: null,        // { snapshot, order, data, cursor }
  };
}

function requireAccount(state, id) {
  const acc = state.accounts[id];
  if (!acc) fail('E_NO_ACCOUNT', `unknown account: ${id}`);
  return acc;
}

function requireAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('E_BAD_AMOUNT', `amount must be a positive number, got: ${value}`);
  }
  return value;
}

// ---- index range helpers (MVCC visibility: begin <= v < end) ----

function closeRange(state, flag, account, version) {
  const ranges = state.index.entries[`${flag}\0${account}`];
  if (!ranges) return;
  const open = ranges.find((r) => r.end === null);
  if (open) open.end = version;
}

function openRange(state, flag, account, version) {
  const key = `${flag}\0${account}`;
  const ranges = state.index.entries[key] ?? (state.index.entries[key] = []);
  if (ranges.some((r) => r.end === null)) {
    fail('E_DUP_RISK', `duplicate risk registration (${flag}, ${account})`);
  }
  ranges.push({ begin: version, end: null });
}

// ---- transactions ----

export function applyTx(state, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    fail('E_BAD_OPS', 'tx body must be {"ops":[...]} with at least one op');
  }
  const next = structuredClone(state);
  const version = next.version + 1;
  const indexActive = next.index.state !== 'none'; // double-write old table + pending/live index

  for (const op of ops) {
    if (!op || typeof op !== 'object') fail('E_BAD_OPS', `invalid op: ${JSON.stringify(op)}`);
    switch (op.op) {
      case 'insert': {
        if (next.accounts[op.account]) fail('E_ACCOUNT_EXISTS', `account exists: ${op.account}`);
        next.accounts[op.account] = {
          balance: op.amount === undefined ? 0 : requireAmount(op.amount),
          riskFlag: null,
          flagVersion: 0,
        };
        break;
      }
      case 'pay': {
        const acc = requireAccount(next, op.account);
        const amount = requireAmount(op.amount);
        if (!op.id) fail('E_BAD_OPS', 'pay requires a payment id');
        if (next.payments[op.id]) fail('E_DUP_PAYMENT', `payment exists: ${op.id}`);
        if (acc.balance < amount) fail('E_INSUFFICIENT', `insufficient funds on ${op.account}`);
        acc.balance -= amount;
        next.payments[op.id] = { account: op.account, amount, version, reversed: false, reverseVersion: null };
        break;
      }
      case 'reverse': {
        const pay = next.payments[op.payment];
        if (!pay) fail('E_NO_PAYMENT', `unknown payment: ${op.payment}`);
        if (pay.reversed) fail('E_ALREADY_REVERSED', `payment already reversed: ${op.payment}`);
        pay.reversed = true;
        pay.reverseVersion = version;
        next.accounts[pay.account].balance += pay.amount;
        break;
      }
      case 'risk': {
        const acc = requireAccount(next, op.account);
        if (typeof op.flag !== 'string' || op.flag.length === 0) fail('E_BAD_OPS', 'risk requires a non-empty flag');
        if (acc.riskFlag === op.flag) {
          fail('E_DUP_RISK', `account ${op.account} already registered with risk flag ${op.flag}`);
        }
        if (indexActive) {
          if (acc.riskFlag) closeRange(next, acc.riskFlag, op.account, version);
          openRange(next, op.flag, op.account, version);
        }
        acc.riskFlag = op.flag;
        acc.flagVersion = version;
        break;
      }
      case 'unrisk': {
        const acc = requireAccount(next, op.account);
        if (!acc.riskFlag) fail('E_NO_RISK', `account ${op.account} has no risk flag`);
        if (indexActive) closeRange(next, acc.riskFlag, op.account, version);
        acc.riskFlag = null;
        acc.flagVersion = version;
        break;
      }
      default:
        fail('E_BAD_OPS', `unknown op: ${op.op}`);
    }
  }

  next.version = version;
  next.history.push({ version, ops: structuredClone(ops) });
  return next;
}

// ---- snapshot scan (reference / old-snapshot path) ----

export function scanAccounts(state, atVersion) {
  const accounts = {};
  for (const { version, ops } of state.history) {
    if (version > atVersion) break;
    for (const op of ops) {
      switch (op.op) {
        case 'insert':
          accounts[op.account] = { balance: op.amount ?? 0, riskFlag: null };
          break;
        case 'pay':
          accounts[op.account].balance -= op.amount;
          break;
        case 'reverse': {
          // payments are resolved against the full log up to atVersion
          const pay = findPayment(state, op.payment, atVersion);
          accounts[pay.account].balance += pay.amount;
          break;
        }
        case 'risk':
          accounts[op.account].riskFlag = op.flag;
          break;
        case 'unrisk':
          accounts[op.account].riskFlag = null;
          break;
      }
    }
  }
  return accounts;
}

function findPayment(state, id, atVersion) {
  for (const { version, ops } of state.history) {
    if (version > atVersion) break;
    for (const op of ops) {
      if (op.op === 'pay' && op.id === id) return { account: op.account, amount: op.amount };
    }
  }
  fail('E_NO_PAYMENT', `unknown payment: ${id}`);
}

// ---- queries ----

export function queryRisk(state, { risk, at, forceScan = false }) {
  const version = at === undefined || at === null ? state.version : Number(at);
  if (!Number.isInteger(version) || version < 0 || version > state.version) {
    fail('E_BAD_VERSION', `version ${at} out of range [0, ${state.version}]`);
  }
  const useIndex = !forceScan && state.index.state === 'ready' && version >= state.index.watermark;
  if (useIndex) {
    const accounts = [];
    const prefix = `${risk}\0`;
    for (const [key, ranges] of Object.entries(state.index.entries)) {
      if (!key.startsWith(prefix)) continue;
      const visible = ranges.some((r) => r.begin <= version && (r.end === null || r.end > version));
      if (visible) accounts.push(key.slice(prefix.length));
    }
    return { accounts: accounts.sort(), source: 'index', at: version };
  }
  const view = scanAccounts(state, version);
  const accounts = Object.keys(view).filter((id) => view[id].riskFlag === risk).sort();
  return { accounts, source: 'scan', at: version };
}

// ---- online index build (backfill) ----

export function beginBackfill(state) {
  if (state.index.state !== 'none') return state;
  const next = structuredClone(state);
  const snapshot = next.version; // tx-start version: the whole scan reads this snapshot
  const order = Object.keys(next.accounts).sort();
  const data = {};
  for (const id of order) {
    const acc = next.accounts[id];
    data[id] = acc.riskFlag ? { flag: acc.riskFlag, flagVersion: acc.flagVersion } : null;
  }
  next.index.state = 'building';
  next.backfill = { snapshot, order, data, cursor: 0 };
  return next;
}

// Processes up to `n` accounts. When the final batch completes, the index
// watermark is written in the SAME commit (one WAL record) as the last entries.
export function backfillBatch(state, n) {
  const bf = state.backfill;
  if (!bf) fail('E_NO_BACKFILL', 'no backfill in progress');
  const next = structuredClone(state);
  const b = next.backfill;
  const end = Math.min(b.cursor + n, b.order.length);
  for (let i = b.cursor; i < end; i++) {
    const id = b.order[i];
    const snap = b.data[id] ?? null;
    if (!snap) continue;
    const current = next.accounts[id];
    // Changed by a concurrent tx after the snapshot? The double-write already
    // maintains the index for this account; never overwrite with stale data.
    if (!current || current.flagVersion !== snap.flagVersion) continue;
    const key = `${snap.flag}\0${id}`;
    // Never register the same (flag, account) pair twice (crash/resume safe).
    if (!(key in next.index.entries)) {
      next.index.entries[key] = [{ begin: snap.flagVersion, end: null }];
    }
  }
  b.cursor = end;
  if (end >= b.order.length) {
    next.index.state = 'ready';
    next.index.watermark = b.snapshot;
    next.backfill = null;
  }
  return next;
}

export function statusView(state) {
  let openRanges = 0;
  for (const ranges of Object.values(state.index.entries)) {
    openRanges += ranges.filter((r) => r.end === null).length;
  }
  return {
    version: state.version,
    accounts: Object.keys(state.accounts).length,
    payments: Object.keys(state.payments).length,
    index: {
      state: state.index.state,
      watermark: state.index.watermark,
      keys: Object.keys(state.index.entries).length,
      openRanges,
    },
    backfill: state.backfill
      ? { snapshot: state.backfill.snapshot, cursor: state.backfill.cursor, total: state.backfill.order.length }
      : null,
  };
}

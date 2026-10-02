import fs from 'node:fs';
import path from 'node:path';

export class DbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

const WAL_FILE = 'wal.log';

function walPath(dir) {
  return path.join(dir, WAL_FILE);
}

function appendWal(state, record) {
  fs.appendFileSync(walPath(state.dir), JSON.stringify(record) + '\n');
}

// ---------- state & replay ----------

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    dir,
    version: 0,
    accounts: new Map(), // id -> [{begin,end,balance,risk}]
    payments: new Map(), // id -> {id,from,to,amount,version,reversed}
    index: { state: 'none', watermark: null, entries: new Map() }, // risk -> [{account,begin,end}]
    backfill: null, // {startVersion, order:[ids], cursor}
  };
  const file = walPath(dir);
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) applyRecord(state, JSON.parse(line));
    }
  }
  return state;
}

function applyRecord(state, rec) {
  switch (rec.type) {
    case 'commit':
      return applyCommit(state, rec);
    case 'backfill-begin':
      state.index = { state: 'building', watermark: null, entries: new Map() };
      state.backfill = { startVersion: rec.startVersion, order: rec.order, cursor: 0 };
      return;
    case 'backfill-scan':
      for (const e of rec.entries) indexOpen(state, e.risk, e.account, e.begin);
      if (state.backfill) state.backfill.cursor = rec.cursor;
      return;
    case 'backfill-final':
      for (const e of rec.entries) indexOpen(state, e.risk, e.account, e.begin);
      state.index.state = 'online';
      state.index.watermark = rec.watermark;
      state.backfill = null;
      return;
    default:
      throw new DbError('E_WAL_CORRUPT', `unknown WAL record type: ${rec.type}`);
  }
}

function applyCommit(state, rec) {
  state.version = rec.version;
  for (const [id, r] of rec.accounts) {
    const chain = state.accounts.get(id) ?? [];
    const prev = chain[chain.length - 1];
    if (prev && prev.end === Infinity) prev.end = rec.version;
    chain.push({ begin: rec.version, end: Infinity, balance: r.balance, risk: r.risk });
    state.accounts.set(id, chain);
  }
  for (const p of rec.payments) state.payments.set(p.id, { ...p, reversed: false });
  for (const pid of rec.reversed) {
    const p = state.payments.get(pid);
    if (p) p.reversed = true;
  }
  for (const op of rec.indexOps) {
    if (op.close !== undefined) indexClose(state, op.close, rec.version);
    else indexOpen(state, op.risk, op.account, rec.version);
  }
}

function indexOpen(state, risk, account, begin) {
  const list = state.index.entries.get(risk) ?? [];
  const open = list.find((e) => e.end === Infinity);
  if (open && open.account === account) return false; // already registered, stay idempotent
  if (open) open.end = begin;
  list.push({ account, begin, end: Infinity });
  state.index.entries.set(risk, list);
  return true;
}

function indexClose(state, risk, at) {
  const list = state.index.entries.get(risk);
  if (!list) return;
  const open = list.find((e) => e.end === Infinity);
  if (open) open.end = at;
}

// ---------- reads ----------

function currentRec(state, id) {
  const chain = state.accounts.get(id);
  const rec = chain?.[chain.length - 1];
  return rec && rec.end === Infinity ? rec : null;
}

export function getAccountAt(state, id, v) {
  const chain = state.accounts.get(id) ?? [];
  for (const r of chain) {
    if (r.begin <= v && v < r.end) return r;
  }
  return null;
}

export function scanByRisk(state, risk, v) {
  const ids = [];
  for (const id of state.accounts.keys()) {
    const rec = getAccountAt(state, id, v);
    if (rec && rec.risk === risk) ids.push(id);
  }
  return ids.sort();
}

export function queryByRisk(state, risk, at, { force } = {}) {
  if (typeof risk !== 'string' || risk.length === 0) {
    throw new DbError('E_BAD_QUERY', 'query requires a non-empty risk flag');
  }
  const v = at === undefined || at === null ? state.version : at;
  if (!Number.isInteger(v) || v < 0 || v > state.version) {
    throw new DbError('E_BAD_VERSION', `version ${v} outside [0, ${state.version}]`);
  }
  const indexUsable = state.index.state === 'online' && v >= state.index.watermark;
  const useIndex = force === 'index' || (force !== 'scan' && indexUsable);
  if (force === 'index' && !indexUsable) {
    throw new DbError('E_INDEX_OFFLINE', `index not usable at version ${v}`);
  }
  const ids = useIndex
    ? (state.index.entries.get(risk) ?? [])
        .filter((e) => e.begin <= v && v < e.end)
        .map((e) => e.account)
    : scanByRisk(state, risk, v);
  const accounts = [];
  for (const id of ids) {
    const rec = getAccountAt(state, id, v);
    if (rec && rec.risk === risk) {
      accounts.push({ account: id, balance: rec.balance, risk: rec.risk });
    }
  }
  accounts.sort((a, b) => (a.account < b.account ? -1 : 1));
  return { version: v, risk, accounts, source: useIndex ? 'index' : 'scan' };
}

export function status(state) {
  let current = 0;
  for (const id of state.accounts.keys()) if (currentRec(state, id)) current++;
  let liveEntries = 0;
  for (const list of state.index.entries.values()) {
    for (const e of list) if (e.end === Infinity) liveEntries++;
  }
  return {
    version: state.version,
    accounts: current,
    payments: state.payments.size,
    index: {
      state: state.index.state,
      watermark: state.index.watermark,
      cursor: state.backfill ? state.backfill.cursor : null,
      total: state.backfill ? state.backfill.order.length : null,
      entries: liveEntries,
    },
  };
}

// ---------- transactions ----------

function reqStr(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DbError('E_BAD_OP', `op requires a non-empty string field: ${field}`);
  }
  return value;
}

export function commit(state, payload) {
  const ops = payload?.ops;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new DbError('E_BAD_TX', 'tx requires a non-empty ops array');
  }
  const version = state.version + 1;
  const touched = new Map(); // id -> {exists,balance,risk}
  const payments = [];
  const reversed = [];

  const load = (id) => {
    if (!touched.has(id)) {
      const cur = currentRec(state, id);
      touched.set(
        id,
        cur
          ? { exists: true, balance: cur.balance, risk: cur.risk }
          : { exists: false, balance: 0, risk: null },
      );
    }
    return touched.get(id);
  };

  const riskInUse = (risk, exceptId) => {
    for (const [id, t] of touched) {
      if (id !== exceptId && t.exists && t.risk === risk) return id;
    }
    for (const [id, chain] of state.accounts) {
      if (id === exceptId || touched.has(id)) continue;
      const cur = chain[chain.length - 1];
      if (cur && cur.end === Infinity && cur.risk === risk) return id;
    }
    return null;
  };

  for (const op of ops) {
    switch (op?.op) {
      case 'insert': {
        const id = reqStr(op.account, 'account');
        const t = load(id);
        if (t.exists) throw new DbError('E_ACCOUNT_EXISTS', `account ${id} already exists`);
        const risk = op.risk ?? null;
        if (risk !== null) {
          const holder = riskInUse(risk, id);
          if (holder) {
            throw new DbError('E_DUP_RISK', `risk flag ${risk} already held by account ${holder}`);
          }
        }
        const balance = op.balance ?? 0;
        if (!Number.isInteger(balance) || balance < 0) {
          throw new DbError('E_BAD_AMOUNT', `invalid opening balance for ${id}`);
        }
        t.exists = true;
        t.balance = balance;
        t.risk = risk;
        break;
      }
      case 'setRisk': {
        const id = reqStr(op.account, 'account');
        const t = load(id);
        if (!t.exists) throw new DbError('E_NO_ACCOUNT', `account ${id} does not exist`);
        const risk = op.risk ?? null;
        if (risk !== null) {
          const holder = riskInUse(risk, id);
          if (holder) {
            throw new DbError('E_DUP_RISK', `risk flag ${risk} already held by account ${holder}`);
          }
        }
        t.risk = risk;
        break;
      }
      case 'pay': {
        const from = reqStr(op.from, 'from');
        const to = reqStr(op.to, 'to');
        const amount = op.amount;
        if (!Number.isInteger(amount) || amount <= 0) {
          throw new DbError('E_BAD_AMOUNT', 'pay amount must be a positive integer');
        }
        const a = load(from);
        const b = load(to);
        if (!a.exists) throw new DbError('E_NO_ACCOUNT', `account ${from} does not exist`);
        if (!b.exists) throw new DbError('E_NO_ACCOUNT', `account ${to} does not exist`);
        if (a.balance < amount) {
          throw new DbError('E_INSUFFICIENT_FUNDS', `account ${from} balance too low`);
        }
        const id = op.id ?? `p${version}-${payments.length + 1}`;
        if (state.payments.has(id) || payments.some((p) => p.id === id)) {
          throw new DbError('E_DUP_PAYMENT', `payment ${id} already exists`);
        }
        a.balance -= amount;
        b.balance += amount;
        payments.push({ id, from, to, amount, version });
        break;
      }
      case 'reverse': {
        const pid = reqStr(op.payment, 'payment');
        const p = state.payments.get(pid);
        if (!p) throw new DbError('E_NO_PAYMENT', `payment ${pid} does not exist`);
        if (p.reversed || reversed.includes(pid)) {
          throw new DbError('E_ALREADY_REVERSED', `payment ${pid} already reversed`);
        }
        const a = load(p.from);
        const b = load(p.to);
        if (b.balance < p.amount) {
          throw new DbError('E_INSUFFICIENT_FUNDS', `reversal would overdraw account ${p.to}`);
        }
        b.balance -= p.amount;
        a.balance += p.amount;
        reversed.push(pid);
        break;
      }
      default:
        throw new DbError('E_BAD_OP', `unknown op: ${op?.op}`);
    }
  }

  const accountChanges = [];
  const indexOps = [];
  const indexing = state.index.state !== 'none';
  for (const [id, t] of touched) {
    const cur = currentRec(state, id);
    const changed =
      (!cur && t.exists) ||
      (cur && (cur.balance !== t.balance || cur.risk !== t.risk));
    if (!changed) continue;
    accountChanges.push([id, { balance: t.balance, risk: t.risk }]);
    // double-write the pending/online index inside the same WAL transaction
    if (indexing && (cur?.risk ?? null) !== t.risk) {
      if (cur?.risk != null) indexOps.push({ close: cur.risk });
      if (t.risk != null) indexOps.push({ risk: t.risk, account: id });
    }
  }

  if (accountChanges.length === 0 && payments.length === 0 && reversed.length === 0) {
    return { version: state.version, noop: true, payments: [] };
  }

  const rec = { type: 'commit', version, accounts: accountChanges, payments, reversed, indexOps };
  appendWal(state, rec);
  applyCommit(state, rec);
  return { version, noop: false, payments: payments.map((p) => p.id) };
}

// ---------- backfill ----------

function beginBackfill(state) {
  const startVersion = state.version;
  const order = [];
  for (const id of state.accounts.keys()) {
    if (getAccountAt(state, id, startVersion)) order.push(id);
  }
  order.sort();
  const rec = { type: 'backfill-begin', startVersion, order };
  appendWal(state, rec);
  applyRecord(state, rec);
}

// Scan a chunk of accounts as of the backfill start version. Accounts whose
// risk flag changed after the start version are owned by the double-write
// path and are skipped, so a restarted backfill never registers an account
// twice and never resurrects a stale flag.
function scanChunk(state, ids) {
  const entries = [];
  let skipped = 0;
  const sv = state.backfill.startVersion;
  for (const id of ids) {
    const rec = getAccountAt(state, id, sv);
    if (!rec || rec.risk == null) continue;
    const head = currentRec(state, id);
    const touchedAfter = head && head.begin > sv;
    if (touchedAfter && head.risk !== rec.risk) {
      skipped++;
      continue;
    }
    const open = state.index.entries.get(rec.risk)?.find((e) => e.end === Infinity);
    if (open) {
      skipped++;
      continue;
    }
    entries.push({ risk: rec.risk, account: id, begin: rec.begin });
  }
  return { entries, skipped };
}

function scanOnce(state, n) {
  const { order, cursor } = state.backfill;
  const chunk = order.slice(cursor, cursor + n);
  const { entries, skipped } = scanChunk(state, chunk);
  const rec = { type: 'backfill-scan', entries, cursor: cursor + chunk.length };
  appendWal(state, rec);
  applyRecord(state, rec);
  return { scanned: chunk.length, skipped };
}

// The final scan chunk and the index watermark are written in one WAL record,
// i.e. one WAL transaction, so the index flips to online atomically.
function finalizeBackfill(state, entries) {
  const rec = { type: 'backfill-final', entries, watermark: state.version };
  appendWal(state, rec);
  applyRecord(state, rec);
}

export function buildIndex(state, { stopAfter = Infinity, batchSize = 16 } = {}) {
  if (state.index.state === 'online') {
    return {
      completed: true,
      alreadyOnline: true,
      resumed: false,
      scanned: 0,
      skipped: 0,
      watermark: state.index.watermark,
    };
  }
  let resumed = true;
  if (!state.backfill) {
    beginBackfill(state);
    resumed = false;
  }
  let scanned = 0;
  let skipped = 0;
  while (state.backfill) {
    const remaining = state.backfill.order.length - state.backfill.cursor;
    if (remaining === 0) {
      finalizeBackfill(state, []);
      break;
    }
    const budget = stopAfter - scanned;
    if (budget <= 0) break;
    const n = Math.min(batchSize, remaining, budget);
    if (state.backfill.cursor + n >= state.backfill.order.length) {
      const chunk = state.backfill.order.slice(state.backfill.cursor, state.backfill.cursor + n);
      const r = scanChunk(state, chunk);
      scanned += chunk.length;
      skipped += r.skipped;
      finalizeBackfill(state, r.entries);
    } else {
      const r = scanOnce(state, n);
      scanned += r.scanned;
      skipped += r.skipped;
    }
  }
  return {
    completed: state.index.state === 'online',
    alreadyOnline: false,
    resumed,
    scanned,
    skipped,
    watermark: state.index.watermark,
  };
}

// Simulated crash: scan half of the table, persist progress, then die before
// the watermark is written. Restart with build-index to resume.
export function crashBackfill(state) {
  if (state.index.state === 'online') {
    throw new DbError('E_INDEX_ONLINE', 'index already online; nothing to crash');
  }
  if (!state.backfill) beginBackfill(state);
  const total = state.backfill.order.length;
  const target = Math.ceil(total / 2);
  while (state.backfill.cursor < target && state.backfill.cursor < total) {
    scanOnce(state, target - state.backfill.cursor);
  }
  return { crashed: true, cursor: state.backfill.cursor, total };
}

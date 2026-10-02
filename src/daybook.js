import {
  resolve,
  commitMutation,
  stateError,
  planInvalid,
  crossDay,
} from './store.js';

function summarize({ state, status, basis }) {
  const date = state.openDate ?? state.lastCommittedDate ?? null;
  const day = date ? state.days[date] : null;
  return { status, date, entries: day ? day.entries.length : 0, basis };
}

export function status(dir) {
  return summarize(resolve(dir, { repair: false }));
}

export function recover(dir) {
  return summarize(resolve(dir, { repair: true }));
}

export function begin(dir, date, { faultAt = null } = {}) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw stateError(`invalid date (want YYYY-MM-DD): ${date}`);
  }
  const { state } = resolve(dir, { repair: true });
  if (state.openDate) throw stateError(`day ${state.openDate} is still open; commit it first`);
  if (state.days[date]) throw stateError(`day ${date} already exists`);
  state.days[date] = { date, status: 'open', entries: [] };
  state.openDate = date;
  commitMutation(dir, state, 'begin', faultAt);
  return { ok: true, date };
}

function validateEntry(entry, day) {
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
    throw stateError('entry.id must be a non-empty string');
  }
  if (day.entries.some((x) => x.id === entry.id)) {
    throw stateError(`duplicate entry id: ${entry.id}`);
  }
  if (typeof entry.account !== 'string' || entry.account.length === 0) {
    throw stateError('entry.account must be a non-empty string');
  }
  if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) {
    throw stateError('entry.amount must be a finite number');
  }
  const type = entry.type ?? 'NORMAL';
  if (type !== 'NORMAL' && type !== 'REVERSAL') {
    throw stateError(`unknown entry type: ${type}`);
  }
  const out = { id: entry.id, account: entry.account, amount: entry.amount, type };
  if (type === 'REVERSAL') {
    if (typeof entry.reversalOf !== 'string' || entry.reversalOf.length === 0) {
      throw stateError('REVERSAL entry requires reversalOf');
    }
    if (!day.entries.some((x) => x.id === entry.reversalOf)) {
      throw stateError(`reversalOf not found in current day: ${entry.reversalOf}`);
    }
    out.reversalOf = entry.reversalOf;
  }
  return out;
}

export function add(dir, entry, { faultAt = null } = {}) {
  const { state } = resolve(dir, { repair: true });
  if (!state.openDate) throw stateError('no open day; run "day begin <date>" first');
  const day = state.days[state.openDate];
  const e = validateEntry(entry, day);
  day.entries.push(e);
  commitMutation(dir, state, 'add', faultAt);
  return { ok: true, date: state.openDate, id: e.id };
}

export function commit(dir, { faultAt = null } = {}) {
  const { state } = resolve(dir, { repair: true });
  if (!state.openDate) throw stateError('no open day to commit');
  const day = state.days[state.openDate];
  day.status = 'committed';
  state.lastCommittedDate = state.openDate;
  state.openDate = null;
  commitMutation(dir, state, 'commit', faultAt);
  return { ok: true, date: day.date };
}

export function rewrite(dir, plan, { faultAt = null } = {}) {
  const { state } = resolve(dir, { repair: true });
  if (plan && typeof plan.date === 'string' && plan.date !== state.openDate) {
    throw crossDay(`plan targets ${plan.date} but current open day is ${state.openDate ?? '(none)'}`);
  }
  if (!state.openDate) throw stateError('no open day to rewrite');
  const committedIds = new Set();
  for (const d of Object.values(state.days)) {
    if (d.status === 'committed') for (const e of d.entries) committedIds.add(e.id);
  }
  const day = state.days[state.openDate];
  day.entries = applyPlan(day.entries, plan, committedIds);
  commitMutation(dir, state, 'rewrite', faultAt);
  return { ok: true, date: state.openDate, entries: day.entries.length };
}

function nets(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.account, (m.get(e.account) ?? 0) + e.amount);
  return m;
}

// Pure plan application, exported so tests can enumerate plans without disk I/O.
// plan: { date?, dropIds?: string[], moveBefore?: ([id,beforeId]|{id,before})[], fixAmounts?: {id:amount} }
export function applyPlan(entries, plan, committedIds = new Set()) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw planInvalid('BAD_PLAN', 'plan must be a JSON object');
  }
  const dropIds = plan.dropIds ?? [];
  const fixAmounts = plan.fixAmounts ?? {};
  const moves = (plan.moveBefore ?? []).map((m) => (Array.isArray(m) ? m : [m.id, m.before]));
  if (!Array.isArray(dropIds) || typeof fixAmounts !== 'object' || fixAmounts === null) {
    throw planInvalid('BAD_PLAN', 'dropIds must be an array and fixAmounts an object');
  }

  const has = (id) => entries.some((e) => e.id === id);
  const need = (id) => {
    if (has(id)) return;
    if (committedIds.has(id)) throw crossDay(`entry ${id} belongs to an already committed day`);
    throw planInvalid('UNKNOWN_ID', `unknown entry id: ${id}`);
  };
  for (const id of dropIds) need(id);
  for (const id of Object.keys(fixAmounts)) need(id);
  for (const [id, before] of moves) {
    if (id === before) throw planInvalid('BAD_MOVE', `cannot move entry ${id} before itself`);
    need(id);
    need(before);
  }
  for (const [id, v] of Object.entries(fixAmounts)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw planInvalid('BAD_AMOUNT', `fixAmounts[${id}] must be a finite number`);
    }
  }

  const netBefore = nets(entries);
  let out = entries.map((e) =>
    Object.hasOwn(fixAmounts, e.id) ? { ...e, amount: fixAmounts[e.id] } : e,
  );
  const drop = new Set(dropIds);
  out = out.filter((e) => !drop.has(e.id));

  // causality: a reversal's original must survive the drops
  for (const e of out) {
    if (e.type === 'REVERSAL' && !out.some((o) => o.id === e.reversalOf)) {
      throw planInvalid('REVERSAL_CAUSALITY', `reversal ${e.id} loses its original ${e.reversalOf}`);
    }
  }

  for (const [id, before] of moves) {
    const i = out.findIndex((e) => e.id === id);
    const b = out.findIndex((e) => e.id === before);
    if (i < 0 || b < 0) throw planInvalid('BAD_MOVE', `move endpoint was dropped: ${id} before ${before}`);
    const [item] = out.splice(i, 1);
    out.splice(out.findIndex((e) => e.id === before), 0, item);
  }

  // causality: a reversal must not precede its original
  const pos = new Map(out.map((e, i) => [e.id, i]));
  for (const e of out) {
    if (e.type === 'REVERSAL' && pos.get(e.reversalOf) > pos.get(e.id)) {
      throw planInvalid('REVERSAL_CAUSALITY', `reversal ${e.id} would precede its original ${e.reversalOf}`);
    }
  }

  const netAfter = nets(out);
  const accounts = new Set([...netBefore.keys(), ...netAfter.keys()]);
  for (const a of accounts) {
    const d = (netAfter.get(a) ?? 0) - (netBefore.get(a) ?? 0);
    if (Math.abs(d) > 1e-9) {
      throw planInvalid('NET_CHANGED', `daily net for account ${a} changes by ${d}`);
    }
  }
  return out;
}

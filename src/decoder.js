import { createHash } from 'node:crypto';
import { LedgerError, E_STOCK, E_VALID } from './errors.js';

export function createState() {
  return { seq: 0, batches: new Map() };
}

export function ensureBatch(state, name, parent = null) {
  let batch = state.batches.get(name);
  if (!batch) {
    batch = { parent, onHand: 0, reserved: 0 };
    state.batches.set(name, batch);
  }
  return batch;
}

export function subtreeMembers(state, root) {
  if (!state.batches.has(root)) return [];
  const children = new Map();
  for (const [name, batch] of state.batches) {
    if (batch.parent !== null) {
      if (!children.has(batch.parent)) children.set(batch.parent, []);
      children.get(batch.parent).push(name);
    }
  }
  for (const list of children.values()) list.sort();
  const out = [];
  const walk = (name) => {
    out.push(name);
    for (const child of children.get(name) ?? []) walk(child);
  };
  walk(root);
  return out;
}

export function subtreeTotals(state, root) {
  let onHand = 0;
  let reserved = 0;
  for (const name of subtreeMembers(state, root)) {
    const batch = state.batches.get(name);
    onHand += batch.onHand;
    reserved += batch.reserved;
  }
  return { onHand, reserved, available: onHand - reserved };
}

export function applyRecord(state, record) {
  if (record.register) {
    ensureBatch(state, record.register.batch, record.register.parent ?? null);
  }
  for (const effect of record.effects ?? []) {
    const batch = ensureBatch(state, effect.batch);
    batch.onHand += effect.onHand ?? 0;
    batch.reserved += effect.reserved ?? 0;
  }
  if (typeof record.seq === 'number') state.seq = record.seq;
}

export function serializeState(state) {
  const batches = {};
  for (const name of [...state.batches.keys()].sort()) {
    const batch = state.batches.get(name);
    batches[name] = { parent: batch.parent, onHand: batch.onHand, reserved: batch.reserved };
  }
  return { seq: state.seq, batches };
}

export function deserializeState(data) {
  const state = createState();
  state.seq = data.seq ?? 0;
  for (const [name, batch] of Object.entries(data.batches ?? {})) {
    state.batches.set(name, {
      parent: batch.parent ?? null,
      onHand: batch.onHand ?? 0,
      reserved: batch.reserved ?? 0,
    });
  }
  return state;
}

export function hashState(state) {
  return createHash('sha256').update(JSON.stringify(serializeState(state).batches)).digest('hex');
}

function assertName(name, what = 'batch') {
  if (typeof name !== 'string' || name.length === 0) {
    throw new LedgerError(E_VALID, `${what} must be a non-empty string`);
  }
}

function assertQty(qty, { allowZero = false } = {}) {
  if (!Number.isInteger(qty) || qty < 0 || (!allowZero && qty === 0)) {
    throw new LedgerError(E_VALID, `qty must be a ${allowZero ? 'non-negative' : 'positive'} integer, got ${qty}`);
  }
}

export function planOp(state, op, params = {}) {
  switch (op) {
    case 'receive': return planReceive(state, params);
    case 'reserve': return planReserve(state, params);
    case 'issue': return planIssue(state, params);
    case 'return': return planReturn(state, params);
    default: throw new LedgerError(E_VALID, `unknown op: ${op}`);
  }
}

function planReceive(state, { batch, qty, parent = null }) {
  assertName(batch);
  assertQty(qty, { allowZero: true });
  if (parent !== null && parent !== undefined) {
    assertName(parent, 'parent');
    if (parent === batch) throw new LedgerError(E_VALID, 'batch cannot be its own parent');
  } else {
    parent = null;
  }
  const existing = state.batches.get(batch);
  let register = null;
  if (!existing) {
    if (parent !== null && !state.batches.has(parent)) {
      throw new LedgerError(E_VALID, `unknown parent batch: ${parent}`);
    }
    register = { batch, parent };
  } else if (parent !== null && existing.parent !== parent) {
    throw new LedgerError(E_VALID, `batch ${batch} already has parent ${existing.parent}`);
  }
  return {
    register,
    effects: [{ batch, onHand: qty }],
    result: { ok: true, op: 'receive', batch, onHand: (existing?.onHand ?? 0) + qty },
  };
}

function planReserve(state, { batch, qty }) {
  assertName(batch);
  assertQty(qty);
  if (!state.batches.has(batch)) {
    throw new LedgerError(E_STOCK, `insufficient stock: unknown batch ${batch}`);
  }
  const totals = subtreeTotals(state, batch);
  if (qty > totals.available) {
    throw new LedgerError(E_STOCK, `insufficient stock on ${batch}: need ${qty}, available ${totals.available}`);
  }
  const current = state.batches.get(batch);
  return {
    register: null,
    effects: [{ batch, reserved: qty }],
    result: {
      ok: true,
      op: 'reserve',
      batch,
      reserved: current.reserved + qty,
      available: totals.available - qty,
    },
  };
}

function planIssue(state, { batch, qty }) {
  assertName(batch);
  assertQty(qty);
  if (!state.batches.has(batch)) {
    throw new LedgerError(E_STOCK, `insufficient stock: unknown batch ${batch}`);
  }
  const totals = subtreeTotals(state, batch);
  if (qty > totals.available) {
    throw new LedgerError(E_STOCK, `insufficient stock on ${batch}: need ${qty}, available ${totals.available}`);
  }
  const members = subtreeMembers(state, batch);
  const base = members.map((name) => {
    const node = state.batches.get(name);
    return Math.max(0, node.onHand - node.reserved);
  });
  const total = base.reduce((sum, value) => sum + value, 0);
  const shares = base.map((value) => Math.floor((qty * value) / total));
  let remainder = qty - shares.reduce((sum, value) => sum + value, 0);
  const order = members.map((_, index) => index).sort((x, y) => {
    const rx = qty * base[x] - shares[x] * total;
    const ry = qty * base[y] - shares[y] * total;
    return ry - rx || x - y;
  });
  for (let k = 0; k < remainder; k += 1) shares[order[k]] += 1;
  const breakdown = members
    .map((name, index) => ({ batch: name, qty: shares[index] }))
    .filter((entry) => entry.qty > 0);
  return {
    register: null,
    effects: breakdown.map((entry) => ({ batch: entry.batch, onHand: -entry.qty })),
    result: { ok: true, op: 'issue', batch, qty, breakdown },
  };
}

function planReturn(state, { batch, qty }) {
  assertName(batch);
  assertQty(qty);
  const existing = state.batches.get(batch);
  return {
    register: existing ? null : { batch, parent: null },
    effects: [{ batch, onHand: qty }],
    result: { ok: true, op: 'return', batch, onHand: (existing?.onHand ?? 0) + qty },
  };
}

'use strict';

const STATUS = Object.freeze({
  COMMITTED: 'COMMITTED',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
  UNSAT: 'UNSAT',
});

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

const REQUEST_TYPES = new Set(['refund', 'void', 'unfreeze']);

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validate(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('input must be a JSON object');
  }
  if (!Array.isArray(input.orders) || input.orders.length === 0) {
    throw new InputError('orders must be a non-empty array');
  }
  const orders = new Map();
  for (const raw of input.orders) {
    if (raw === null || typeof raw !== 'object' || typeof raw.orderId !== 'string' || raw.orderId === '') {
      throw new InputError('each order needs a non-empty string orderId');
    }
    if (orders.has(raw.orderId)) {
      throw new InputError(`duplicate order "${raw.orderId}"`);
    }
    if (!isNonNegativeNumber(raw.charged)) {
      throw new InputError(`order "${raw.orderId}" has illegal charged amount`);
    }
    const frozen = raw.frozen === undefined ? 0 : raw.frozen;
    if (!isNonNegativeNumber(frozen)) {
      throw new InputError(`order "${raw.orderId}" has illegal frozen amount`);
    }
    orders.set(raw.orderId, { orderId: raw.orderId, charged: raw.charged, frozen });
  }
  if (!Array.isArray(input.requests)) {
    throw new InputError('requests must be an array');
  }
  const requests = input.requests.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InputError(`request #${i} must be an object`);
    }
    if (typeof raw.id !== 'string' || raw.id === '') {
      throw new InputError(`request #${i} is missing a non-empty string id`);
    }
    if (!REQUEST_TYPES.has(raw.type)) {
      throw new InputError(`request "${raw.id}" has unknown type "${raw.type}"`);
    }
    if (typeof raw.orderId !== 'string' || !orders.has(raw.orderId)) {
      throw new InputError(`request "${raw.id}" references unknown order "${raw.orderId}"`);
    }
    let amount = null;
    if (raw.type === 'void') {
      if (raw.amount !== undefined && !isNonNegativeNumber(raw.amount)) {
        throw new InputError(`request "${raw.id}" has illegal amount`);
      }
    } else {
      if (!isPositiveNumber(raw.amount)) {
        throw new InputError(`request "${raw.id}" has illegal amount`);
      }
      amount = raw.amount;
    }
    const arrival = raw.arrival === undefined ? i : raw.arrival;
    if (!Number.isInteger(arrival)) {
      throw new InputError(`request "${raw.id}" has illegal arrival (must be an integer)`);
    }
    const key = raw.key === undefined ? raw.id : raw.key;
    if (typeof key !== 'string' || key === '') {
      throw new InputError(`request "${raw.id}" has illegal idempotency key`);
    }
    const after = raw.after === undefined ? [] : raw.after;
    if (!Array.isArray(after) || after.some((a) => typeof a !== 'string')) {
      throw new InputError(`request "${raw.id}" has illegal after (must be an array of request ids)`);
    }
    return { id: raw.id, key, type: raw.type, orderId: raw.orderId, amount, arrival, after };
  });
  return { orders, requests };
}

function findCycle(nodeCount, edges) {
  const adj = Array.from({ length: nodeCount }, () => []);
  for (const [from, to] of edges) adj[from].push(to);
  const color = new Array(nodeCount).fill(0);
  const stack = [];
  for (let root = 0; root < nodeCount; root++) {
    if (color[root] !== 0) continue;
    color[root] = 1;
    stack.push(root);
    const frames = [[root, 0]];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const node = frame[0];
      if (frame[1] < adj[node].length) {
        const next = adj[node][frame[1]++];
        if (color[next] === 0) {
          color[next] = 1;
          stack.push(next);
          frames.push([next, 0]);
        } else if (color[next] === 1) {
          const start = stack.indexOf(next);
          return stack.slice(start).concat([next]);
        }
      } else {
        color[node] = 2;
        stack.pop();
        frames.pop();
      }
    }
  }
  return null;
}

function prepare(input) {
  const { orders, requests } = validate(input);

  const sorted = requests
    .map((req, ord) => ({ req, ord }))
    .sort((a, b) => (a.req.arrival - b.req.arrival) || (a.ord - b.ord))
    .map(({ req }) => req);

  const byKey = new Map();
  const canonical = [];
  const duplicates = [];
  for (const req of sorted) {
    const existing = byKey.get(req.key);
    if (existing) {
      duplicates.push({ req, canonical: existing });
    } else {
      const entry = { ...req, index: canonical.length };
      byKey.set(req.key, entry);
      canonical.push(entry);
    }
  }

  const byId = new Map();
  for (const c of canonical) byId.set(c.id, c);
  for (const d of duplicates) {
    if (!byId.has(d.req.id)) byId.set(d.req.id, d.canonical);
  }

  const edges = [];
  for (const c of canonical) {
    for (const depId of c.after) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new InputError(`request "${c.id}" depends on unknown request "${depId}"`);
      }
      if (dep.index === c.index) {
        throw new InputError(`request "${c.id}" depends on itself`);
      }
      edges.push([dep.index, c.index]);
    }
  }

  const voidsByOrder = new Map();
  for (const c of canonical) {
    if (c.type !== 'void') continue;
    if (!voidsByOrder.has(c.orderId)) voidsByOrder.set(c.orderId, []);
    voidsByOrder.get(c.orderId).push(c.index);
  }
  const naturalEdges = [];
  for (const c of canonical) {
    if (c.type !== 'unfreeze') continue;
    for (const v of voidsByOrder.get(c.orderId) || []) {
      naturalEdges.push([v, c.index]);
    }
  }

  const cycle = findCycle(canonical.length, edges.concat(naturalEdges));
  const cycleSet = new Set(cycle || []);

  const unsatReasons = new Map();
  for (const c of canonical) {
    const order = orders.get(c.orderId);
    if (c.type === 'refund' && c.amount > order.charged) {
      unsatReasons.set(c.index, `refund ${c.amount} exceeds charged total ${order.charged}`);
    } else if (c.type === 'unfreeze' && c.amount > order.frozen) {
      unsatReasons.set(c.index, `unfreeze ${c.amount} exceeds frozen total ${order.frozen}`);
    }
  }
  for (const idx of cycleSet) {
    if (!unsatReasons.has(idx)) {
      unsatReasons.set(idx, 'unserializable dependency cycle');
    }
  }

  const candidates = canonical
    .filter((c) => !unsatReasons.has(c.index))
    .map((c) => c.index);

  return { orders, canonical, duplicates, edges, cycle, unsatReasons, candidates };
}

function freshOrderState(orders) {
  const state = new Map();
  for (const [id, o] of orders) {
    state.set(id, { charged: o.charged, refunded: 0, voided: false, frozenLeft: o.frozen });
  }
  return state;
}

function chooseCommitSequence(candidates, canonical, orders, edges) {
  const preds = new Map();
  for (const [before, after] of edges) {
    if (!preds.has(after)) preds.set(after, []);
    preds.get(after).push(before);
  }

  const state = freshOrderState(orders);
  const used = new Array(canonical.length).fill(false);
  const seq = [];

  function eligible(idx) {
    const c = canonical[idx];
    const st = state.get(c.orderId);
    if (c.type === 'refund') {
      if (st.voided) return false;
      if (st.refunded + c.amount > st.charged) return false;
    } else if (c.type === 'unfreeze') {
      if (!st.voided) return false;
      if (c.amount > st.frozenLeft) return false;
    }
    const ps = preds.get(idx);
    if (ps) {
      for (const p of ps) if (!used[p]) return false;
    }
    return true;
  }

  function apply(idx) {
    const c = canonical[idx];
    const st = state.get(c.orderId);
    if (c.type === 'refund') st.refunded += c.amount;
    else if (c.type === 'void') st.voided = true;
    else st.frozenLeft -= c.amount;
  }

  function undo(idx) {
    const c = canonical[idx];
    const st = state.get(c.orderId);
    if (c.type === 'refund') st.refunded -= c.amount;
    else if (c.type === 'void') st.voided = false;
    else st.frozenLeft += c.amount;
  }

  function hopefulCount() {
    let count = 0;
    for (const idx of candidates) {
      if (used[idx]) continue;
      const c = canonical[idx];
      const st = state.get(c.orderId);
      if (c.type === 'refund') {
        if (st.voided) continue;
        if (st.refunded + c.amount > st.charged) continue;
      } else if (c.type === 'unfreeze') {
        if (c.amount > st.frozenLeft) continue;
      }
      count++;
    }
    return count;
  }

  function dfs(target) {
    if (seq.length === target) return seq.slice();
    if (seq.length + hopefulCount() < target) return null;
    for (const idx of candidates) {
      if (used[idx] || !eligible(idx)) continue;
      used[idx] = true;
      seq.push(idx);
      apply(idx);
      const found = dfs(target);
      if (found) return found;
      undo(idx);
      seq.pop();
      used[idx] = false;
    }
    return null;
  }

  for (let target = candidates.length; target >= 1; target--) {
    const found = dfs(target);
    if (found) return found;
  }
  return [];
}

function solveHistory(input) {
  const { orders, canonical, duplicates, edges, cycle, unsatReasons, candidates } = prepare(input);

  const seq = chooseCommitSequence(candidates, canonical, orders, edges);
  const slotOf = new Map(seq.map((idx, slot) => [idx, slot]));

  const voidCommittedByOrder = new Map();
  for (const idx of seq) {
    const c = canonical[idx];
    if (c.type === 'void') voidCommittedByOrder.set(c.orderId, true);
  }

  const predsOf = new Map();
  for (const [before, after] of edges) {
    if (!predsOf.has(after)) predsOf.set(after, []);
    predsOf.get(after).push(before);
  }

  const results = canonical.map((c) => {
    const entry = {
      id: c.id,
      key: c.key,
      type: c.type,
      orderId: c.orderId,
      amount: c.amount,
      arrival: c.arrival,
      status: null,
      slot: null,
      reason: null,
    };
    if (unsatReasons.has(c.index)) {
      entry.status = STATUS.UNSAT;
      entry.reason = unsatReasons.get(c.index);
      return entry;
    }
    if (slotOf.has(c.index)) {
      entry.status = STATUS.COMMITTED;
      entry.slot = slotOf.get(c.index);
      return entry;
    }
    const preds = predsOf.get(c.index) || [];
    const blockedByDep = preds.some((p) => !slotOf.has(p));
    if (c.type === 'refund') {
      if (voidCommittedByOrder.get(c.orderId)) {
        entry.status = STATUS.REJECTED;
        entry.reason = 'void committed for order; new refunds are rejected';
      } else if (blockedByDep) {
        entry.status = STATUS.PENDING;
        entry.reason = 'blocked by uncommitted dependency';
      } else {
        entry.status = STATUS.PENDING;
        entry.reason = 'insufficient refundable balance';
      }
    } else if (c.type === 'unfreeze') {
      entry.status = STATUS.PENDING;
      if (blockedByDep) entry.reason = 'blocked by uncommitted dependency';
      else if (!voidCommittedByOrder.get(c.orderId)) entry.reason = 'awaiting successful void';
      else entry.reason = 'insufficient frozen balance';
    } else {
      entry.status = STATUS.PENDING;
      entry.reason = 'blocked by uncommitted dependency';
    }
    return entry;
  });

  for (const { req, canonical: canon } of duplicates) {
    const base = results[canon.index];
    const mismatch =
      req.type !== canon.type || req.orderId !== canon.orderId || req.amount !== canon.amount;
    results.push({
      id: req.id,
      key: req.key,
      type: req.type,
      orderId: req.orderId,
      amount: req.amount,
      arrival: req.arrival,
      status: base.status,
      slot: base.slot,
      reason: base.reason,
      replayOf: canon.id,
      payloadMismatch: mismatch || undefined,
    });
  }
  results.sort((a, b) => a.arrival - b.arrival);

  const state = freshOrderState(orders);
  const balances = seq.map((idx, slot) => {
    const c = canonical[idx];
    const st = state.get(c.orderId);
    if (c.type === 'refund') st.refunded += c.amount;
    else if (c.type === 'void') st.voided = true;
    else st.frozenLeft -= c.amount;
    return {
      slot,
      requestId: c.id,
      orderId: c.orderId,
      refunded: st.refunded,
      refundable: st.charged - st.refunded,
      frozenRemaining: st.frozenLeft,
      voided: st.voided,
    };
  });

  return {
    status: unsatReasons.size > 0 ? STATUS.UNSAT : 'OK',
    commitOrder: seq.map((idx) => canonical[idx].id),
    requests: results,
    balances,
    conflictCycle: cycle ? cycle.map((idx) => canonical[idx].id) : null,
  };
}

module.exports = {
  STATUS,
  InputError,
  solveHistory,
  _prepare: prepare,
  _chooseCommitSequence: chooseCommitSequence,
};

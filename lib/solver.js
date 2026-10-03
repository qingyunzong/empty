'use strict';

const EPSILON = 1e-9;
const TYPES = new Set(['REFUND', 'CANCEL', 'UNFREEZE']);

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('input must be a JSON object');
  }
  if (!Array.isArray(input.orders) || input.orders.length === 0) {
    throw new InputError('orders must be a non-empty array');
  }
  const orders = new Map();
  for (const order of input.orders) {
    if (!order || typeof order.orderId !== 'string' || order.orderId.length === 0) {
      throw new InputError('every order needs a string orderId');
    }
    if (orders.has(order.orderId)) {
      throw new InputError(`duplicate order ${order.orderId}`);
    }
    if (!isFiniteNumber(order.charged) || order.charged <= 0) {
      throw new InputError(`invalid charged amount for order ${order.orderId}`);
    }
    orders.set(order.orderId, { orderId: order.orderId, charged: order.charged });
  }
  if (!Array.isArray(input.requests)) {
    throw new InputError('requests must be an array');
  }
  const seenIds = new Set();
  const requests = input.requests.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new InputError(`request #${index} is not an object`);
    }
    if (typeof raw.requestId !== 'string' || raw.requestId.length === 0) {
      throw new InputError(`request #${index} is missing requestId`);
    }
    if (seenIds.has(raw.requestId)) {
      throw new InputError(`duplicate requestId ${raw.requestId}`);
    }
    seenIds.add(raw.requestId);
    if (!TYPES.has(raw.type)) {
      throw new InputError(`request ${raw.requestId} has unknown type ${String(raw.type)}`);
    }
    if (typeof raw.orderId !== 'string' || !orders.has(raw.orderId)) {
      throw new InputError(`request ${raw.requestId} references unknown order ${String(raw.orderId)}`);
    }
    let amount = null;
    if (raw.type === 'REFUND') {
      if (!isFiniteNumber(raw.amount) || raw.amount <= 0) {
        throw new InputError(`request ${raw.requestId} has invalid amount ${String(raw.amount)}`);
      }
      amount = raw.amount;
    }
    const arrivalSeq = Number.isInteger(raw.arrivalSeq) && raw.arrivalSeq >= 0 ? raw.arrivalSeq : index;
    const idempotencyKey = typeof raw.idempotencyKey === 'string' && raw.idempotencyKey.length > 0
      ? raw.idempotencyKey
      : raw.requestId;
    const after = raw.after === undefined ? [] : raw.after;
    if (!Array.isArray(after) || after.some((id) => typeof id !== 'string')) {
      throw new InputError(`request ${raw.requestId} has invalid after dependencies`);
    }
    return { requestId: raw.requestId, idempotencyKey, type: raw.type, orderId: raw.orderId, amount, arrivalSeq, after, index };
  });
  return { orders, requests };
}

function dedupeRequests(requests) {
  const canonicalByKey = new Map();
  for (const request of requests) {
    const current = canonicalByKey.get(request.idempotencyKey);
    if (!current
        || request.arrivalSeq < current.arrivalSeq
        || (request.arrivalSeq === current.arrivalSeq && request.index < current.index)) {
      canonicalByKey.set(request.idempotencyKey, request);
    }
  }
  const canonical = [...canonicalByKey.values()]
    .sort((a, b) => a.arrivalSeq - b.arrivalSeq || a.index - b.index);
  const replayOf = new Map();
  for (const request of requests) {
    const winner = canonicalByKey.get(request.idempotencyKey);
    if (winner !== request) {
      replayOf.set(request.requestId, winner.requestId);
    }
  }
  return { canonical, replayOf };
}

function resolveDependencies(canonical) {
  const canonicalById = new Map(canonical.map((request) => [request.requestId, request]));
  const deps = new Map(canonical.map((request) => [request.requestId, []]));
  for (const request of canonical) {
    for (const depId of request.after) {
      const target = canonicalById.get(depId);
      if (!target) {
        throw new InputError(`request ${request.requestId} depends on unknown request ${depId}`);
      }
      if (target.requestId !== request.requestId) {
        deps.get(request.requestId).push(target.requestId);
      }
    }
  }
  return deps;
}

function findHardConflict(orders, canonical, deps) {
  for (const request of canonical) {
    if (request.type === 'REFUND' && request.amount > orders.get(request.orderId).charged + EPSILON) {
      return {
        cycle: [request.requestId],
        reason: `REFUND ${request.requestId} amount ${request.amount} exceeds charged amount of order ${request.orderId}`,
      };
    }
  }
  const firstCancelByOrder = new Map();
  for (const request of canonical) {
    if (request.type === 'CANCEL' && !firstCancelByOrder.has(request.orderId)) {
      firstCancelByOrder.set(request.orderId, request);
    }
  }
  const edges = new Map(canonical.map((request) => [request.requestId, []]));
  for (const request of canonical) {
    if (request.type === 'UNFREEZE') {
      const cancel = firstCancelByOrder.get(request.orderId);
      if (!cancel) {
        return {
          cycle: [request.requestId],
          reason: `UNFREEZE ${request.requestId} has no CANCEL request for order ${request.orderId}`,
        };
      }
      edges.get(cancel.requestId).push(request.requestId);
    }
    for (const depId of deps.get(request.requestId)) {
      edges.get(depId).push(request.requestId);
    }
  }
  const state = new Map();
  const stack = [];
  let cycle = null;
  const visit = (node) => {
    if (cycle) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node)) {
      if (cycle) return;
      const mark = state.get(next) || 0;
      if (mark === 0) {
        visit(next);
      } else if (mark === 1) {
        cycle = stack.slice(stack.indexOf(next)).concat(next);
        return;
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const request of canonical) {
    if (cycle) break;
    if (!state.has(request.requestId)) visit(request.requestId);
  }
  if (cycle) {
    return { cycle, reason: 'cyclic happens-before dependency between requests' };
  }
  return null;
}

function makeOrderState(orders) {
  const state = new Map();
  for (const orderId of orders.keys()) {
    state.set(orderId, { refunded: 0, cancelled: false, unfrozen: false });
  }
  return state;
}

function guardHolds(request, orders, orderState, committedSet, deps) {
  for (const depId of deps.get(request.requestId)) {
    if (!committedSet.has(depId)) return false;
  }
  const order = orders.get(request.orderId);
  const state = orderState.get(request.orderId);
  switch (request.type) {
    case 'REFUND':
      return !state.cancelled && state.refunded + request.amount <= order.charged + EPSILON;
    case 'CANCEL':
      return !state.cancelled;
    case 'UNFREEZE':
      return state.cancelled && !state.unfrozen;
    default:
      return false;
  }
}

function applyRequest(request, orderState) {
  const state = orderState.get(request.orderId);
  if (request.type === 'REFUND') state.refunded += request.amount;
  if (request.type === 'CANCEL') state.cancelled = true;
  if (request.type === 'UNFREEZE') state.unfrozen = true;
}

// Commit-slot selection: repeatedly commit the earliest-arriving waiting
// request whose guards hold (arrival-priority greedy fixpoint). Waiting
// requests are replayed into the next slot once constraints become
// satisfiable; requests still waiting at the fixpoint are PENDING.
function solveGreedy(orders, canonical, deps) {
  const orderState = makeOrderState(orders);
  const committed = [];
  const committedSet = new Set();
  const waiting = new Set(canonical);
  let progress = true;
  while (progress) {
    progress = false;
    for (const request of canonical) {
      if (!waiting.has(request)) continue;
      if (guardHolds(request, orders, orderState, committedSet, deps)) {
        applyRequest(request, orderState);
        committed.push(request);
        committedSet.add(request.requestId);
        waiting.delete(request);
        progress = true;
        break;
      }
    }
  }
  return { committed, pending: [...waiting] };
}

// Reference for small instances (<= 5 canonical requests): enumerate every
// permutation, simulate committing in that order (skipping requests whose
// guard fails at their turn), and verify that the greedy commit sequence is
// realizable and that every greedy choice was forced by arrival priority.
function referenceVerify(orders, canonical, deps, committed) {
  if (canonical.length > 5) {
    throw new Error('reference verifier supports at most 5 requests');
  }
  const positions = new Map(canonical.map((request, index) => [request.requestId, index]));
  const simulate = (permutation) => {
    const orderState = makeOrderState(orders);
    const committedSet = new Set();
    const sequence = [];
    for (const request of permutation) {
      if (guardHolds(request, orders, orderState, committedSet, deps)) {
        applyRequest(request, orderState);
        committedSet.add(request.requestId);
        sequence.push(request);
      }
    }
    return sequence;
  };
  const greedyIds = committed.map((request) => request.requestId);
  const permutations = [];
  const permute = (items, prefix) => {
    if (items.length === 0) {
      permutations.push(prefix);
      return;
    }
    for (let i = 0; i < items.length; i += 1) {
      permute(items.slice(0, i).concat(items.slice(i + 1)), prefix.concat(items[i]));
    }
  };
  permute(canonical, []);
  const realizable = permutations.some((permutation) => {
    const sequence = simulate(permutation);
    return sequence.length === committed.length
      && sequence.every((request, index) => request.requestId === greedyIds[index]);
  });
  if (!realizable) {
    return { ok: false, detail: 'greedy commit sequence is not a valid linearization' };
  }
  // Greedy-choice property: at each slot, no earlier-arriving waiting request
  // was enabled; at the end, no waiting request is enabled at all.
  const orderState = makeOrderState(orders);
  const committedSet = new Set();
  for (let slot = 0; slot < committed.length; slot += 1) {
    const chosen = committed[slot];
    for (const request of canonical) {
      if (committedSet.has(request.requestId) || request.requestId === chosen.requestId) continue;
      if (positions.get(request.requestId) < positions.get(chosen.requestId)
          && guardHolds(request, orders, orderState, committedSet, deps)) {
        return { ok: false, detail: `slot ${slot + 1}: earlier request ${request.requestId} was enabled` };
      }
    }
    applyRequest(chosen, orderState);
    committedSet.add(chosen.requestId);
  }
  for (const request of canonical) {
    if (!committedSet.has(request.requestId)
        && guardHolds(request, orders, orderState, committedSet, deps)) {
      return { ok: false, detail: `pending request ${request.requestId} is still enabled at fixpoint` };
    }
  }
  return { ok: true, detail: 'matches permutation-enumeration reference' };
}

function solveHistory(input) {
  const { orders, requests } = normalizeInput(input);
  const { canonical, replayOf } = dedupeRequests(requests);
  const deps = resolveDependencies(canonical);
  const conflict = findHardConflict(orders, canonical, deps);

  const requestResults = new Map();
  const result = {
    status: 'OK',
    commitOrder: [],
    slots: {},
    requests: [],
    orders: [],
    balanceTrajectory: [],
    conflictCycle: null,
    reason: null,
  };

  if (conflict) {
    result.status = 'UNSAT';
    result.conflictCycle = conflict.cycle;
    result.reason = conflict.reason;
    const inCycle = new Set(conflict.cycle);
    for (const request of canonical) {
      requestResults.set(request.requestId, {
        status: inCycle.has(request.requestId) ? 'REJECTED' : 'PENDING',
        slot: null,
      });
    }
  } else {
    const { committed, pending } = solveGreedy(orders, canonical, deps);
    const orderState = makeOrderState(orders);
    committed.forEach((request, index) => {
      const slot = index + 1;
      applyRequest(request, orderState);
      const state = orderState.get(request.orderId);
      const order = orders.get(request.orderId);
      result.commitOrder.push(request.requestId);
      result.slots[request.requestId] = slot;
      result.balanceTrajectory.push({
        slot,
        requestId: request.requestId,
        type: request.type,
        orderId: request.orderId,
        refunded: state.refunded,
        balance: order.charged - state.refunded,
        cancelled: state.cancelled,
        unfrozen: state.unfrozen,
      });
      requestResults.set(request.requestId, { status: 'COMMITTED', slot });
    });
    for (const request of pending) {
      requestResults.set(request.requestId, { status: 'PENDING', slot: null });
    }
    if (pending.length > 0) {
      result.status = 'PENDING';
      result.reason = 'one or more requests are waiting for budget or slot constraints';
    }
    result.orders = [...orders.values()].map((order) => {
      const state = orderState.get(order.orderId);
      return {
        orderId: order.orderId,
        charged: order.charged,
        refunded: state.refunded,
        balance: order.charged - state.refunded,
        cancelled: state.cancelled,
        unfrozen: state.unfrozen,
      };
    });
  }

  if (result.orders.length === 0) {
    result.orders = [...orders.values()].map((order) => ({
      orderId: order.orderId,
      charged: order.charged,
      refunded: 0,
      balance: order.charged,
      cancelled: false,
      unfrozen: false,
    }));
  }

  const sorted = [...requests].sort((a, b) => a.arrivalSeq - b.arrivalSeq || a.index - b.index);
  result.requests = sorted.map((request) => {
    const replayTarget = replayOf.get(request.requestId);
    if (replayTarget) {
      const target = requestResults.get(replayTarget);
      return {
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        type: request.type,
        orderId: request.orderId,
        amount: request.amount,
        arrivalSeq: request.arrivalSeq,
        status: 'REPLAY',
        replayOf: replayTarget,
        slot: target.slot,
      };
    }
    const outcome = requestResults.get(request.requestId);
    return {
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      type: request.type,
      orderId: request.orderId,
      amount: request.amount,
      arrivalSeq: request.arrivalSeq,
      status: outcome.status,
      slot: outcome.slot,
    };
  });

  return result;
}

module.exports = {
  EPSILON,
  InputError,
  normalizeInput,
  dedupeRequests,
  resolveDependencies,
  findHardConflict,
  makeOrderState,
  guardHolds,
  applyRequest,
  solveGreedy,
  referenceVerify,
  solveHistory,
};

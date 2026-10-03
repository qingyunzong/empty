'use strict';

const LINEAR_STATUSES = ['created', 'assigned', 'in_progress', 'done'];
const STATUSES = [...LINEAR_STATUSES, 'canceled'];
const TERMINAL_STATUSES = new Set(['done', 'canceled']);
const ORDER_FIELDS = ['status', 'assignee', 'priority'];

const TRANSITIONS = new Map([
  ['created', new Set(['assigned', 'canceled'])],
  ['assigned', new Set(['in_progress', 'canceled'])],
  ['in_progress', new Set(['done', 'canceled'])],
  ['done', new Set()],
  ['canceled', new Set()],
]);

const EXIT = Object.freeze({ OK: 0, CONFLICT: 1, INVALID: 2 });

class OrderError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'OrderError';
    this.exitCode = exitCode;
  }
}

class MergeConflict extends OrderError {
  constructor(conflicts) {
    super(EXIT.CONFLICT, `merge produced ${conflicts.length} conflict(s)`);
    this.name = 'MergeConflict';
    this.conflicts = conflicts;
  }
}

function isValidStatus(status) {
  return STATUSES.includes(status);
}

function isLegalTransition(from, to) {
  const next = TRANSITIONS.get(from);
  return Boolean(next && next.has(to));
}

function validateOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw new OrderError(EXIT.INVALID, 'each order must be an object');
  }
  if (typeof order.id !== 'string' || order.id === '') {
    throw new OrderError(EXIT.INVALID, 'each order requires a non-empty string id');
  }
  if (!isValidStatus(order.status)) {
    throw new OrderError(EXIT.INVALID, `order ${order.id}: unknown status ${JSON.stringify(order.status)}`);
  }
  for (const field of ['assignee', 'priority']) {
    if (!(field in order)) {
      throw new OrderError(EXIT.INVALID, `order ${order.id}: missing field ${field}`);
    }
  }
}

function indexById(orders) {
  if (!Array.isArray(orders)) {
    throw new OrderError(EXIT.INVALID, 'orders must be an array');
  }
  const map = new Map();
  for (const order of orders) {
    validateOrder(order);
    if (map.has(order.id)) {
      throw new OrderError(EXIT.INVALID, `duplicate order id: ${order.id}`);
    }
    map.set(order.id, {
      id: order.id,
      status: order.status,
      assignee: order.assignee,
      priority: order.priority,
    });
  }
  return map;
}

function toOrders(map) {
  return [...map.values()].map((order) => ({ ...order }));
}

function diffOrders(base, target) {
  const baseMap = indexById(base);
  const targetMap = indexById(target);
  for (const id of targetMap.keys()) {
    if (!baseMap.has(id)) {
      throw new OrderError(EXIT.INVALID, `unknown order: ${id}`);
    }
  }
  const changes = [];
  for (const [id, before] of baseMap) {
    const after = targetMap.get(id);
    if (!after) {
      throw new OrderError(EXIT.INVALID, `unknown order: ${id} (missing in target)`);
    }
    for (const field of ORDER_FIELDS) {
      if (!Object.is(before[field], after[field])) {
        changes.push({ id, field, from: before[field], to: after[field] });
      }
    }
  }
  return { changes };
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || !Array.isArray(patch.changes)) {
    throw new OrderError(EXIT.INVALID, 'patch must be an object with a changes array');
  }
  return patch.changes;
}

function applyChange(map, change, { enforceTransitions }) {
  if (!change || typeof change !== 'object') {
    throw new OrderError(EXIT.INVALID, 'patch change must be an object');
  }
  const { id, field } = change;
  const order = map.get(id);
  if (!order) {
    throw new OrderError(EXIT.INVALID, `unknown order: ${id}`);
  }
  if (!ORDER_FIELDS.includes(field)) {
    throw new OrderError(EXIT.INVALID, `unknown field: ${JSON.stringify(field)}`);
  }
  if (!Object.is(order[field], change.from)) {
    throw new OrderError(
      EXIT.INVALID,
      `patch does not apply to order ${id}: field ${field} is ` +
        `${JSON.stringify(order[field])}, expected ${JSON.stringify(change.from)}`
    );
  }
  if (field === 'status') {
    if (!isValidStatus(change.to)) {
      throw new OrderError(EXIT.INVALID, `unknown status: ${JSON.stringify(change.to)}`);
    }
    if (
      enforceTransitions &&
      change.from !== change.to &&
      !isLegalTransition(change.from, change.to)
    ) {
      throw new OrderError(
        EXIT.INVALID,
        `illegal status transition for order ${id}: ${change.from} -> ${change.to}`
      );
    }
  }
  order[field] = change.to;
}

function applyPatch(orders, patch) {
  const map = indexById(orders);
  for (const change of validatePatch(patch)) {
    applyChange(map, change, { enforceTransitions: true });
  }
  return toOrders(map);
}

function undoPatch(orders, patch) {
  const map = indexById(orders);
  const changes = validatePatch(patch);
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i];
    applyChange(
      map,
      { id: change.id, field: change.field, from: change.to, to: change.from },
      { enforceTransitions: false }
    );
  }
  return toOrders(map);
}

function redoPatch(orders, patch) {
  return applyPatch(orders, patch);
}

function summarize(changesByField) {
  const summary = {};
  for (const [field, change] of changesByField) {
    summary[field] = change.to;
  }
  return summary;
}

function mergeOrders(base, local, remote) {
  const baseMap = indexById(base);
  const localPatch = diffOrders(base, local);
  const remotePatch = diffOrders(base, remote);

  const groupById = (patch) => {
    const grouped = new Map();
    for (const change of patch.changes) {
      if (!grouped.has(change.id)) grouped.set(change.id, new Map());
      grouped.get(change.id).set(change.field, change);
    }
    return grouped;
  };
  const localById = groupById(localPatch);
  const remoteById = groupById(remotePatch);

  const merged = indexById(base);
  const conflicts = [];
  const changedIds = new Set([...localById.keys(), ...remoteById.keys()]);

  for (const id of changedIds) {
    const baseOrder = baseMap.get(id);
    const localChanges = localById.get(id) || new Map();
    const remoteChanges = remoteById.get(id) || new Map();

    if (TERMINAL_STATUSES.has(baseOrder.status)) {
      conflicts.push({
        id,
        reason: 'terminal-order-modified',
        message: `order ${id} is ${baseOrder.status} and cannot be modified`,
        local: summarize(localChanges),
        remote: summarize(remoteChanges),
      });
      continue;
    }

    const target = merged.get(id);
    const fields = new Set([...localChanges.keys(), ...remoteChanges.keys()]);
    let statusConflicted = false;
    for (const field of fields) {
      const localChange = localChanges.get(field);
      const remoteChange = remoteChanges.get(field);
      if (localChange && remoteChange) {
        if (Object.is(localChange.to, remoteChange.to)) {
          target[field] = localChange.to;
        } else {
          if (field === 'status') statusConflicted = true;
          conflicts.push({
            id,
            field,
            reason: 'both-modified',
            base: baseOrder[field],
            local: localChange.to,
            remote: remoteChange.to,
          });
        }
      } else {
        target[field] = (localChange || remoteChange).to;
      }
    }

    if (statusConflicted) continue;
    const newStatus = target.status;
    if (newStatus !== baseOrder.status && !isLegalTransition(baseOrder.status, newStatus)) {
      conflicts.push({
        id,
        field: 'status',
        reason: 'illegal-transition',
        base: baseOrder.status,
        local: localChanges.has('status') ? localChanges.get('status').to : baseOrder.status,
        remote: remoteChanges.has('status') ? remoteChanges.get('status').to : baseOrder.status,
      });
    }
  }

  if (conflicts.length > 0) {
    throw new MergeConflict(conflicts);
  }
  return toOrders(merged);
}

module.exports = {
  LINEAR_STATUSES,
  STATUSES,
  TERMINAL_STATUSES,
  ORDER_FIELDS,
  TRANSITIONS,
  EXIT,
  OrderError,
  MergeConflict,
  isValidStatus,
  isLegalTransition,
  diffOrders,
  applyPatch,
  undoPatch,
  redoPatch,
  mergeOrders,
};

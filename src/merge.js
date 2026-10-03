'use strict';

const { isTerminal, canTransition } = require('./stateMachine');
const { normalizeOrders } = require('./repo');
const { ConflictError } = require('./errors');

function orderFields(order) {
  return Object.keys(order);
}

function ordersEqual(a, b) {
  const keys = new Set([...orderFields(a), ...orderFields(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function changedFields(base, other) {
  const changed = [];
  const keys = new Set([...orderFields(base), ...orderFields(other)]);
  for (const key of keys) {
    if (base[key] !== other[key]) changed.push(key);
  }
  return changed;
}

function mergeOrderFields(id, base, local, remote, conflicts) {
  const merged = { id };
  const fields = new Set([
    ...orderFields(base),
    ...orderFields(local),
    ...orderFields(remote),
  ]);
  fields.delete('id');
  for (const field of fields) {
    const b = base[field];
    const l = local[field];
    const r = remote[field];
    if (l === r) {
      merged[field] = l;
    } else if (b === l) {
      merged[field] = r;
    } else if (b === r) {
      merged[field] = l;
    } else {
      conflicts.push({
        orderId: id,
        field,
        reason: 'both sides changed field "' + field + '" to different values',
        base: b,
        local: l,
        remote: r,
      });
    }
  }
  return merged;
}

function mergeOrders(baseInput, localInput, remoteInput) {
  const base = normalizeOrders(baseInput);
  const local = normalizeOrders(localInput);
  const remote = normalizeOrders(remoteInput);

  const conflicts = [];
  const merged = {};
  const ids = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const id of ids) {
    const inBase = Object.prototype.hasOwnProperty.call(base, id);
    const inLocal = Object.prototype.hasOwnProperty.call(local, id);
    const inRemote = Object.prototype.hasOwnProperty.call(remote, id);

    if (!inBase) {
      if (inLocal && inRemote) {
        if (ordersEqual(local[id], remote[id])) {
          merged[id] = { ...local[id] };
        } else {
          conflicts.push({ orderId: id, reason: 'order added on both sides with different content' });
        }
      } else {
        merged[id] = { ...(inLocal ? local[id] : remote[id]) };
      }
      continue;
    }

    if (!inLocal || !inRemote) {
      const survivor = inLocal ? local[id] : inRemote ? remote[id] : null;
      if (survivor === null) continue;
      if (ordersEqual(base[id], survivor)) continue;
      conflicts.push({ orderId: id, reason: 'order deleted on one side but modified on the other' });
      continue;
    }

    const b = base[id];
    const l = local[id];
    const r = remote[id];

    if (isTerminal(b.status)) {
      const localChanged = changedFields(b, l);
      const remoteChanged = changedFields(b, r);
      if (localChanged.length > 0 || remoteChanged.length > 0) {
        conflicts.push({
          orderId: id,
          reason: 'order is in terminal state "' + b.status + '" but a side tried to modify it',
          localChanged,
          remoteChanged,
        });
        continue;
      }
      merged[id] = { ...b };
      continue;
    }

    const mergedOrder = mergeOrderFields(id, b, l, r, conflicts);
    if (conflicts.some((c) => c.orderId === id)) continue;

    if (mergedOrder.status !== b.status && !canTransition(b.status, mergedOrder.status)) {
      conflicts.push({
        orderId: id,
        field: 'status',
        reason: 'illegal status transition after merge: ' + b.status + ' -> ' + mergedOrder.status,
      });
      continue;
    }

    merged[id] = mergedOrder;
  }

  if (conflicts.length > 0) {
    throw new ConflictError('merge produced ' + conflicts.length + ' conflict(s)', conflicts);
  }
  return merged;
}

module.exports = { mergeOrders };

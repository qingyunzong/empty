'use strict';

const { isValidState, isTerminal, canTransition } = require('./stateMachine');
const { UnknownOrderError, InvalidPatchError } = require('./errors');

const ORDER_FIELDS = Object.freeze(['id', 'status', 'assignee', 'priority']);
const PATCHABLE_FIELDS = Object.freeze(['status', 'assignee', 'priority']);

function validateOrder(order) {
  if (order === null || typeof order !== 'object' || Array.isArray(order)) {
    throw new InvalidPatchError('order must be an object');
  }
  for (const key of Object.keys(order)) {
    if (!ORDER_FIELDS.includes(key)) {
      throw new InvalidPatchError('unknown order field: ' + key);
    }
  }
  if (typeof order.id !== 'string' || order.id.length === 0) {
    throw new InvalidPatchError('order id must be a non-empty string');
  }
  if (!isValidState(order.status)) {
    throw new InvalidPatchError('invalid status: ' + String(order.status));
  }
  return order;
}

function normalizeOrders(input) {
  const orders = {};
  if (Array.isArray(input)) {
    for (const order of input) {
      validateOrder(order);
      if (Object.prototype.hasOwnProperty.call(orders, order.id)) {
        throw new InvalidPatchError('duplicate order id: ' + order.id);
      }
      orders[order.id] = { ...order };
    }
  } else if (input !== null && typeof input === 'object') {
    for (const [id, raw] of Object.entries(input)) {
      const order = { id, ...raw };
      if (raw !== null && typeof raw === 'object' && 'id' in raw && raw.id !== id) {
        throw new InvalidPatchError('order id mismatch for key: ' + id);
      }
      validateOrder(order);
      orders[id] = order;
    }
  } else {
    throw new InvalidPatchError('orders must be an array or an object map');
  }
  return orders;
}

function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new InvalidPatchError('patch must be an object');
  }
  if (typeof patch.id !== 'string' || patch.id.length === 0) {
    throw new InvalidPatchError('patch id must be a non-empty string');
  }
  const changes = patch.changes;
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new InvalidPatchError('patch changes must be an object');
  }
  for (const [field, value] of Object.entries(changes)) {
    if (!PATCHABLE_FIELDS.includes(field)) {
      throw new InvalidPatchError('cannot patch field: ' + field);
    }
    if (field === 'status' && !isValidState(value)) {
      throw new InvalidPatchError('invalid status: ' + String(value));
    }
  }
  return patch;
}

class OrderRepo {
  constructor(input) {
    this.orders = input === undefined ? {} : normalizeOrders(input);
    this.history = [];
    this.redoStack = [];
  }

  get(id) {
    const order = this.orders[id];
    if (!order) throw new UnknownOrderError(id);
    return { ...order };
  }

  has(id) {
    return Object.prototype.hasOwnProperty.call(this.orders, id);
  }

  toJSON() {
    const out = {};
    for (const [id, order] of Object.entries(this.orders)) out[id] = { ...order };
    return out;
  }

  apply(patch) {
    validatePatch(patch);
    const order = this.orders[patch.id];
    if (!order) throw new UnknownOrderError(patch.id);
    if (isTerminal(order.status)) {
      throw new InvalidPatchError('order ' + patch.id + ' is in terminal state ' + order.status);
    }
    if (Object.prototype.hasOwnProperty.call(patch.changes, 'status')) {
      const next = patch.changes.status;
      if (next !== order.status && !canTransition(order.status, next)) {
        throw new InvalidPatchError(
          'illegal status transition for order ' + patch.id + ': ' + order.status + ' -> ' + next
        );
      }
    }
    const inverse = { id: patch.id, changes: {} };
    for (const [field, value] of Object.entries(patch.changes)) {
      inverse.changes[field] = order[field];
      order[field] = value;
    }
    this.history.push({ patch: clonePatch(patch), inverse });
    this.redoStack.length = 0;
    return clonePatch(inverse);
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    this.#applyInverse(entry.inverse);
    this.redoStack.push(entry);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const order = this.orders[entry.patch.id];
    if (!order) throw new UnknownOrderError(entry.patch.id);
    if (Object.prototype.hasOwnProperty.call(entry.patch.changes, 'status')) {
      const next = entry.patch.changes.status;
      if (next !== order.status && !canTransition(order.status, next)) {
        this.redoStack.push(entry);
        throw new InvalidPatchError(
          'illegal status transition for order ' + entry.patch.id + ': ' + order.status + ' -> ' + next
        );
      }
    }
    for (const [field, value] of Object.entries(entry.patch.changes)) {
      order[field] = value;
    }
    this.history.push(entry);
    return true;
  }

  #applyInverse(inverse) {
    const order = this.orders[inverse.id];
    if (!order) throw new UnknownOrderError(inverse.id);
    for (const [field, value] of Object.entries(inverse.changes)) {
      order[field] = value;
    }
  }
}

function clonePatch(patch) {
  return { id: patch.id, changes: { ...patch.changes } };
}

module.exports = { OrderRepo, normalizeOrders, validateOrder, validatePatch, ORDER_FIELDS, PATCHABLE_FIELDS };

'use strict';

const { solveCirculation } = require('./circulation');

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const MUTATION_OPS = new Set(['add-edge', 'update-edge', 'remove-edge']);

function requireNodeName(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_NODE', `field "${field}" must be a non-empty string`);
  }
  return value;
}

function requireBound(value, field) {
  if (!Number.isInteger(value)) {
    throw new LedgerError('INVALID_CAPACITY', `field "${field}" must be an integer`);
  }
  if (value < 0) {
    throw new LedgerError('NEGATIVE_CAPACITY', `field "${field}" must not be negative, got ${value}`);
  }
  return value;
}

function requireEventId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_EVENT_ID', 'field "id" must be a non-empty string');
  }
  return value;
}

// A ledger of edge-mutation events over a clearing network, with
// id-addressed undo/redo and circulation feasibility evaluation.
class Ledger {
  constructor() {
    this.edges = new Map(); // "from->to" -> { from, to, lower, upper }
    this.applied = []; // stack of applied mutation records
    this.undone = []; // stack of undone mutation records (redo candidates)
    this.eventIds = new Set();
  }

  static key(from, to) {
    return `${from}->${to}`;
  }

  nodeNames() {
    const names = new Set();
    for (const edge of this.edges.values()) {
      names.add(edge.from);
      names.add(edge.to);
    }
    return names;
  }

  applyEvent(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new LedgerError('INVALID_EVENT', 'event must be a JSON object');
    }
    const { op } = event;
    if (!MUTATION_OPS.has(op)) {
      throw new LedgerError('UNKNOWN_OP', `unknown mutation op: ${String(op)}`);
    }
    const id = requireEventId(event.id);
    if (this.eventIds.has(id)) {
      throw new LedgerError('DUPLICATE_EVENT_ID', `event id "${id}" was already used`);
    }
    const from = requireNodeName(event.from, 'from');
    const to = requireNodeName(event.to, 'to');
    const key = Ledger.key(from, to);

    let record;
    if (op === 'add-edge') {
      const lower = requireBound(event.lower, 'lower');
      const upper = requireBound(event.upper, 'upper');
      if (lower > upper) {
        throw new LedgerError('LOWER_EXCEEDS_UPPER', `lower ${lower} exceeds upper ${upper} on ${key}`);
      }
      if (this.edges.has(key)) {
        throw new LedgerError('EDGE_EXISTS', `edge ${key} already exists`);
      }
      record = { event: { op, id, from, to }, kind: 'add', key, after: { from, to, lower, upper } };
    } else {
      const existing = this.requireEdge(key, from, to);
      if (op === 'update-edge') {
        const lower = event.lower === undefined ? existing.lower : requireBound(event.lower, 'lower');
        const upper = event.upper === undefined ? existing.upper : requireBound(event.upper, 'upper');
        if (lower > upper) {
          throw new LedgerError('LOWER_EXCEEDS_UPPER', `lower ${lower} exceeds upper ${upper} on ${key}`);
        }
        record = {
          event: { op, id, from, to },
          kind: 'update',
          key,
          before: { ...existing },
          after: { from, to, lower, upper },
        };
      } else {
        record = { event: { op, id, from, to }, kind: 'remove', key, before: { ...existing } };
      }
    }

    this.applyRecord(record);
    this.applied.push(record);
    this.eventIds.add(id);
    this.undone = []; // a fresh mutation invalidates the redo stack
    return record;
  }

  requireEdge(key, from, to) {
    const existing = this.edges.get(key);
    if (existing) return existing;
    const known = this.nodeNames();
    for (const node of [from, to]) {
      if (!known.has(node)) {
        throw new LedgerError('UNKNOWN_NODE', `unknown node "${node}"`);
      }
    }
    throw new LedgerError('UNKNOWN_EDGE', `unknown edge ${key}`);
  }

  applyRecord(record) {
    if (record.kind === 'remove') {
      this.edges.delete(record.key);
    } else {
      this.edges.set(record.key, { ...record.after });
    }
  }

  revertRecord(record) {
    if (record.kind === 'add') {
      this.edges.delete(record.key);
    } else {
      this.edges.set(record.key, { ...record.before });
    }
  }

  undo(id) {
    requireEventId(id);
    const top = this.applied[this.applied.length - 1];
    if (!top || top.event.id !== id) {
      throw new LedgerError(
        'UNDO_MISMATCH',
        top
          ? `cannot undo "${id}": most recent applied event is "${top.event.id}"`
          : `cannot undo "${id}": no applied events`,
      );
    }
    this.applied.pop();
    this.revertRecord(top);
    this.undone.push(top);
    return top;
  }

  redo(id) {
    requireEventId(id);
    const top = this.undone[this.undone.length - 1];
    if (!top || top.event.id !== id) {
      throw new LedgerError(
        'REDO_MISMATCH',
        top
          ? `cannot redo "${id}": most recent undone event is "${top.event.id}"`
          : `cannot redo "${id}": no undone events`,
      );
    }
    this.undone.pop();
    this.applyRecord(top);
    this.applied.push(top);
    return top;
  }

  evaluate() {
    return solveCirculation([...this.edges.values()]);
  }
}

module.exports = { Ledger, LedgerError, MUTATION_OPS };

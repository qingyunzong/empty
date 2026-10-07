'use strict';

const { CalendarError, assertInterval, overlaps } = require('./intervals');

const COMMAND_KINDS = new Set(['occupy', 'release', 'override']);

// Server-style single-machine concurrency engine.
//
// Every committed command bumps the global version and appends its written
// intervals. A command carries a baseVersion: if any interval committed
// *after* baseVersion overlaps the command's read interval set (same
// resource), the command is rejected with a REVISION conflict certificate
// naming both command ids and the first overlapping millisecond.
//
// Transactions nest. A failed command rolls back only the intervals written
// by the innermost active transaction; outer transactions (and their
// savepoints) survive and may still commit, keeping their own writes.
class Engine {
  constructor() {
    this.version = 0;
    this.committed = []; // {resource, start, end, kind, status, commandId, version}
    this.journal = [];   // uncommitted entries of the open transaction stack
    this.txStack = [];   // {id, marker, savepoints: Map<name, journalIndex>}
    this.txCounter = 0;
  }

  process(op) {
    try {
      return this.#dispatch(op);
    } catch (err) {
      if (err instanceof CalendarError) {
        return { ok: false, error: { code: err.code, message: err.message, details: err.details ?? null } };
      }
      throw err;
    }
  }

  processAll(ops) {
    return ops.map((op) => this.process(op));
  }

  #dispatch(op) {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
      throw new CalendarError('INVALID_OP', 'each op must be an object with an "op" field');
    }
    switch (op.op) {
      case 'begin': return this.#begin(op);
      case 'savepoint': return this.#savepoint(op);
      case 'release': return this.#releaseSavepoint(op);
      case 'rollbackTo': return this.#rollbackTo(op);
      case 'commit': return this.#commit(op);
      case 'rollback': return this.#rollback(op);
      case 'command': return this.#command(op.command);
      default: throw new CalendarError('INVALID_OP', `unknown op: ${op.op}`);
    }
  }

  #currentTx() {
    return this.txStack.length ? this.txStack[this.txStack.length - 1] : null;
  }

  #begin(op) {
    const id = op.tx ?? `tx${++this.txCounter}`;
    this.txStack.push({ id, marker: this.journal.length, savepoints: new Map() });
    return { ok: true, op: 'begin', tx: id, depth: this.txStack.length };
  }

  #savepoint(op) {
    const tx = this.#currentTx();
    if (!tx) throw new CalendarError('NO_TRANSACTION', 'savepoint outside a transaction');
    if (typeof op.name !== 'string') throw new CalendarError('INVALID_OP', 'savepoint needs a name');
    tx.savepoints.set(op.name, this.journal.length);
    return { ok: true, op: 'savepoint', name: op.name, tx: tx.id };
  }

  #releaseSavepoint(op) {
    const tx = this.#currentTx();
    if (!tx) throw new CalendarError('NO_TRANSACTION', 'release outside a transaction');
    if (!tx.savepoints.has(op.name)) {
      throw new CalendarError('UNKNOWN_SAVEPOINT', `unknown savepoint: ${op.name}`, { name: op.name });
    }
    tx.savepoints.delete(op.name);
    return { ok: true, op: 'release', name: op.name, tx: tx.id };
  }

  #rollbackTo(op) {
    const tx = this.#currentTx();
    if (!tx) throw new CalendarError('NO_TRANSACTION', 'rollbackTo outside a transaction');
    if (!tx.savepoints.has(op.name)) {
      throw new CalendarError('UNKNOWN_SAVEPOINT', `unknown savepoint: ${op.name}`, { name: op.name });
    }
    const idx = tx.savepoints.get(op.name);
    this.journal.length = idx;
    for (const [name, at] of tx.savepoints) {
      if (at > idx) tx.savepoints.delete(name);
    }
    return { ok: true, op: 'rollbackTo', name: op.name, tx: tx.id };
  }

  #commit(op) {
    const tx = this.#currentTx();
    if (!tx) throw new CalendarError('NO_TRANSACTION', 'commit outside a transaction');
    if (op.tx !== undefined && op.tx !== tx.id) {
      throw new CalendarError('TX_MISMATCH', `commit for ${op.tx} but innermost is ${tx.id}`);
    }
    this.txStack.pop();
    if (this.txStack.length === 0) {
      const versions = this.#flush(this.journal.splice(0));
      return { ok: true, op: 'commit', tx: tx.id, versions };
    }
    // Inner commit merges into the parent transaction's journal in place.
    return { ok: true, op: 'commit', tx: tx.id, mergedInto: this.#currentTx().id };
  }

  #rollback(op) {
    const tx = this.#currentTx();
    if (!tx) throw new CalendarError('NO_TRANSACTION', 'rollback outside a transaction');
    if (op.tx !== undefined && op.tx !== tx.id) {
      throw new CalendarError('TX_MISMATCH', `rollback for ${op.tx} but innermost is ${tx.id}`);
    }
    this.txStack.pop();
    this.journal.length = tx.marker;
    return { ok: true, op: 'rollback', tx: tx.id };
  }

  #flush(entries) {
    const versions = [];
    for (const e of entries) {
      this.version += 1;
      const stored = { ...e, version: this.version };
      delete stored.txDepth;
      this.committed.push(stored);
      versions.push({ commandId: e.commandId, version: this.version });
    }
    return versions;
  }

  #command(cmd) {
    if (!cmd || typeof cmd !== 'object') throw new CalendarError('INVALID_COMMAND', 'command must be an object');
    if (!COMMAND_KINDS.has(cmd.kind)) {
      throw new CalendarError('INVALID_COMMAND', `unknown command kind: ${cmd.kind}`);
    }
    if (typeof cmd.resource !== 'string' || cmd.resource.length === 0) {
      throw new CalendarError('INVALID_COMMAND', 'command needs a resource');
    }
    if (typeof cmd.id !== 'string' || cmd.id.length === 0) {
      throw new CalendarError('INVALID_COMMAND', 'command needs an id');
    }
    if (!Number.isSafeInteger(cmd.baseVersion) || cmd.baseVersion < 0) {
      throw new CalendarError('INVALID_COMMAND', 'command needs a non-negative baseVersion');
    }
    if (cmd.baseVersion > this.version) {
      throw new CalendarError('INVALID_COMMAND', `baseVersion ${cmd.baseVersion} is in the future`);
    }
    assertInterval(cmd.start, cmd.end);

    const conflict = this.#findConflict(cmd);
    if (conflict) {
      const certificate = {
        commandId: cmd.id,
        conflictCommandId: conflict.commandId,
        resource: cmd.resource,
        firstOverlapMs: Math.max(cmd.start, conflict.start),
      };
      const tx = this.#currentTx();
      const result = { ok: false, error: { code: 'REVISION', certificate } };
      if (tx) {
        // Hierarchical rollback: undo only what the innermost transaction
        // wrote; outer transactions keep their writes and may still commit.
        this.txStack.pop();
        this.journal.length = tx.marker;
        result.rolledBackTx = tx.id;
      }
      return result;
    }

    const entry = {
      resource: cmd.resource,
      start: cmd.start,
      end: cmd.end,
      kind: cmd.kind,
      status: cmd.kind === 'override' ? cmd.status ?? null : null,
      commandId: cmd.id,
    };
    if (this.txStack.length) {
      this.journal.push(entry);
      return { ok: true, commandId: cmd.id, buffered: true, tx: this.#currentTx().id };
    }
    const [v] = this.#flush([entry]);
    return { ok: true, commandId: cmd.id, version: v.version };
  }

  #findConflict(cmd) {
    for (const iv of this.committed) {
      if (iv.resource !== cmd.resource) continue;
      if (iv.version <= cmd.baseVersion) continue;
      if (overlaps(iv.start, iv.end, cmd.start, cmd.end)) return iv;
    }
    return null;
  }

  // Snapshot of committed intervals, optionally filtered by resource.
  committedIntervals(resource) {
    return this.committed
      .filter((iv) => resource === undefined || iv.resource === resource)
      .map((iv) => ({ ...iv }));
  }
}

module.exports = { Engine };

'use strict';

const { CODES, LedgerError } = require('./errors');
const { nextState } = require('./dfa');

const UNDOABLE_OPS = new Set(['debit', 'credit', 'hold', 'release', 'commit', 'void']);
const INVERSE_OP = { debit: 'credit', credit: 'debit', hold: 'release', release: 'hold' };

class Ledger {
  constructor() {
    this.accounts = new Map(); // name -> { state, balance, held }
    this.events = new Map(); // id -> applied event record { id, op, account, amount, parent, meta }
    this.head = null; // id of the last applied event
    this.batchStack = []; // open batch frames, innermost last
  }

  getAccount(name) {
    const acct = this.accounts.get(name);
    return acct ? { ...acct } : undefined;
  }

  getState() {
    const accounts = {};
    for (const [name, acct] of this.accounts) accounts[name] = { ...acct };
    return { head: this.head, accounts };
  }

  snapshot() {
    return this.getState();
  }

  clone() {
    const copy = new Ledger();
    for (const [name, acct] of this.accounts) copy.accounts.set(name, { ...acct });
    for (const [id, rec] of this.events) {
      copy.events.set(id, { ...rec, meta: rec.meta ? { ...rec.meta } : {} });
    }
    copy.head = this.head;
    return copy;
  }

  _account(name) {
    let acct = this.accounts.get(name);
    if (!acct) {
      acct = { state: 'INIT', balance: 0, held: 0 };
      this.accounts.set(name, acct);
    }
    return acct;
  }

  _captureForRollback(name) {
    if (this.batchStack.length === 0) return;
    const frame = this.batchStack[this.batchStack.length - 1];
    if (!frame.captured.has(name)) frame.captured.set(name, { ...this._account(name) });
  }

  _noteEventInBatch(id) {
    if (this.batchStack.length === 0) return;
    this.batchStack[this.batchStack.length - 1].eventsAdded.push(id);
  }

  _fail(acct, code, message, details) {
    acct.state = 'ERROR';
    if (this.batchStack.length > 0) {
      this.batchStack[this.batchStack.length - 1].failed = true;
    }
    throw new LedgerError(code, message, details);
  }

  apply(event) {
    if (!event || typeof event.id !== 'string' || typeof event.op !== 'string' || typeof event.account !== 'string') {
      throw new LedgerError(CODES.ILLEGAL_TRANSITION, 'malformed event: id, op and account are required');
    }
    const existing = this.events.get(event.id);
    if (existing) {
      if (existing.op === event.op && existing.account === event.account && existing.amount === event.amount) {
        return { ok: true, duplicate: true };
      }
      throw new LedgerError(CODES.ILLEGAL_TRANSITION, `conflicting duplicate event id ${event.id}`);
    }
    const acct = this._account(event.account);
    this._captureForRollback(event.account);
    if (event.op === 'undo') return this._applyUndo(event, acct);

    const prevState = acct.state;
    const target = nextState(prevState, event.op);
    if (!target) {
      return this._fail(acct, CODES.ILLEGAL_TRANSITION, `op ${event.op} not allowed in state ${prevState}`);
    }
    const meta = {};
    try {
      this._mutate(acct, event, meta);
    } catch (err) {
      if (err instanceof LedgerError) return this._fail(acct, err.code, err.message, err.details);
      throw err;
    }
    acct.state = target;
    this._record(event, meta);
    return { ok: true };
  }

  _mutate(acct, event, meta) {
    const amount = event.amount;
    switch (event.op) {
      case 'open':
        acct.balance = typeof event.balance === 'number' ? event.balance : 0;
        acct.held = 0;
        break;
      case 'debit':
        checkAmount(amount);
        if (acct.balance - acct.held < amount) {
          throw new LedgerError(CODES.NEGATIVE, `debit ${amount} exceeds available ${acct.balance - acct.held}`);
        }
        acct.balance -= amount;
        break;
      case 'credit':
        checkAmount(amount);
        acct.balance += amount;
        break;
      case 'hold':
        checkAmount(amount);
        if (acct.balance - acct.held < amount) {
          throw new LedgerError(CODES.NEGATIVE, `hold ${amount} exceeds available ${acct.balance - acct.held}`);
        }
        acct.held += amount;
        break;
      case 'release':
        checkAmount(amount);
        if (acct.held < amount) {
          throw new LedgerError(CODES.HOLD_LEAK, `release ${amount} exceeds held ${acct.held}`);
        }
        acct.held -= amount;
        break;
      case 'commit':
        if (acct.held > 0) {
          throw new LedgerError(CODES.HOLD_LEAK, `commit with ${acct.held} still held`);
        }
        break;
      case 'void':
        meta.released = acct.held;
        acct.held = 0;
        break;
      case 'repair':
        break;
      default:
        throw new LedgerError(CODES.ILLEGAL_TRANSITION, `unknown op ${event.op}`);
    }
  }

  _record(event, meta) {
    const rec = {
      id: event.id,
      op: event.op,
      account: event.account,
      amount: event.amount,
      parent: event.parent !== undefined ? event.parent : this.head,
      meta,
    };
    this.events.set(event.id, rec);
    this.head = event.id;
    this._noteEventInBatch(event.id);
  }

  // ---- undo ----

  _applyUndo(event, acct) {
    const prevState = acct.state;
    const target = nextState(prevState, 'undo');
    if (!target) {
      return this._fail(acct, CODES.ILLEGAL_TRANSITION, `undo not allowed in state ${prevState}`);
    }
    // Plan first: a failed undo (fork conflict, non-undoable target) never mutates state.
    const plan = this.undoPlan(event.target);
    for (const step of plan) this._applyInverse(acct, step);
    acct.state = target;
    this._record(event, { undoes: event.target });
    return { ok: true, plan };
  }

  undoPlan(targetId) {
    const targetRec = this.events.get(targetId);
    if (!targetRec) {
      throw new LedgerError(CODES.FORK_CONFLICT, `undo target ${targetId} is unknown`, { witness: null });
    }
    if (!UNDOABLE_OPS.has(targetRec.op)) {
      throw new LedgerError(CODES.ILLEGAL_TRANSITION, `event ${targetId} (${targetRec.op}) is not undoable`);
    }
    // Walk the unique parent chain from head; target must be an ancestor of head.
    const headChain = [];
    let cursor = this.head;
    let found = false;
    while (cursor) {
      headChain.push(cursor);
      if (cursor === targetId) { found = true; break; }
      const rec = this.events.get(cursor);
      cursor = rec ? rec.parent : null;
    }
    if (!found) {
      const witness = this._forkWitness(targetId, headChain);
      throw new LedgerError(
        CODES.FORK_CONFLICT,
        `undo target ${targetId} is not an ancestor of head ${this.head}`,
        { witness },
      );
    }
    const pathDown = headChain.slice().reverse(); // target .. head
    const conflicts = [];
    for (const id of pathDown.slice(1)) {
      const rec = this.events.get(id);
      if (rec && rec.account === targetRec.account) conflicts.push(id);
    }
    if (conflicts.length > 0) {
      throw new LedgerError(
        CODES.FORK_CONFLICT,
        `undo of ${targetId} conflicts with later events on account ${targetRec.account}`,
        { witness: { path: pathDown, conflicts } },
      );
    }
    return [inverseOf(targetRec)];
  }

  _forkWitness(targetId, headChain) {
    const headSet = new Set(headChain);
    const targetPath = [];
    let cursor = targetId;
    let fork = null;
    while (cursor) {
      targetPath.push(cursor);
      if (headSet.has(cursor)) { fork = cursor; break; }
      const rec = this.events.get(cursor);
      cursor = rec ? rec.parent : null;
    }
    const headPath = [];
    for (const id of headChain) {
      headPath.push(id);
      if (id === fork) break;
    }
    return { fork, headPath, targetPath };
  }

  _applyInverse(acct, step) {
    switch (step.op) {
      case 'credit':
        acct.balance += step.amount;
        break;
      case 'debit':
        if (acct.balance - acct.held < step.amount) {
          throw new LedgerError(CODES.NEGATIVE, `inverse debit ${step.amount} exceeds available`);
        }
        acct.balance -= step.amount;
        break;
      case 'release':
        if (acct.held < step.amount) {
          throw new LedgerError(CODES.HOLD_LEAK, `inverse release ${step.amount} exceeds held`);
        }
        acct.held -= step.amount;
        break;
      case 'hold':
        if (acct.balance - acct.held < step.amount) {
          throw new LedgerError(CODES.NEGATIVE, `inverse hold ${step.amount} exceeds available`);
        }
        acct.held += step.amount;
        break;
      case 'reopen':
        if (step.restoreHeld) acct.held += step.restoreHeld;
        break;
      default:
        throw new LedgerError(CODES.ILLEGAL_TRANSITION, `unknown inverse op ${step.op}`);
    }
  }

  // ---- hierarchical batches ----

  beginBatch(id, options = {}) {
    const onChildFailure = options.onChildFailure === 'abort' ? 'abort' : 'continue';
    this.batchStack.push({
      id: id || `batch-${this.batchStack.length + 1}`,
      onChildFailure,
      failed: false,
      captured: new Map(), // account -> state before first mutation inside this batch
      eventsAdded: [],
      headBefore: this.head,
    });
    return this.batchStack.length;
  }

  endBatch() {
    const frame = this.batchStack.pop();
    if (!frame) throw new LedgerError(CODES.ILLEGAL_TRANSITION, 'endBatch with no open batch');
    const parent = this.batchStack[this.batchStack.length - 1];
    if (frame.failed) {
      for (const [name, snap] of frame.captured) this.accounts.set(name, { ...snap });
      for (const id of frame.eventsAdded) this.events.delete(id);
      this.head = frame.headBefore;
      if (parent && parent.onChildFailure === 'abort') parent.failed = true;
      return { id: frame.id, rolledBack: true };
    }
    if (parent) {
      for (const [name, snap] of frame.captured) {
        if (!parent.captured.has(name)) parent.captured.set(name, snap);
      }
      parent.eventsAdded.push(...frame.eventsAdded);
    }
    return { id: frame.id, rolledBack: false };
  }
}

function checkAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError(CODES.ILLEGAL_TRANSITION, `invalid amount ${amount}`);
  }
}

function inverseOf(rec) {
  if (Object.prototype.hasOwnProperty.call(INVERSE_OP, rec.op)) {
    return { op: INVERSE_OP[rec.op], account: rec.account, amount: rec.amount, undoes: rec.id };
  }
  if (rec.op === 'commit') {
    return { op: 'reopen', account: rec.account, undoes: rec.id };
  }
  // void
  return { op: 'reopen', account: rec.account, restoreHeld: rec.meta && rec.meta.released ? rec.meta.released : 0, undoes: rec.id };
}

module.exports = { Ledger, UNDOABLE_OPS };

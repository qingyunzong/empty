'use strict';

const { ERR, initialAccount, transition } = require('./core');

const UNDOABLE = new Set(['debit', 'credit', 'hold', 'release']);

function freshAccount() {
  return { ...initialAccount(), head: null, events: new Map(), undone: new Set() };
}

class Ledger {
  constructor() {
    this.accounts = new Map();
    this.seenIds = new Set();
    this.errors = [];
    this.undoPlans = [];
    this.seq = 0;
  }

  static restore(data) {
    const ledger = new Ledger();
    for (const [id, a] of Object.entries(data.accounts || {})) {
      ledger.accounts.set(id, {
        status: a.status,
        prevStatus: a.prevStatus,
        balance: a.balance,
        frozen: a.frozen,
        head: a.head,
        events: new Map((a.events || []).map((e) => [e.id, e])),
        undone: new Set(a.undone || []),
      });
      for (const e of a.events || []) ledger.seenIds.add(e.id);
      if (typeof a.seq === 'number' && a.seq > ledger.seq) ledger.seq = a.seq;
    }
    if (typeof data.seq === 'number') ledger.seq = data.seq;
    return ledger;
  }

  serialize() {
    const accounts = {};
    for (const [id, a] of this.accounts) {
      accounts[id] = {
        status: a.status,
        prevStatus: a.prevStatus,
        balance: a.balance,
        frozen: a.frozen,
        head: a.head,
        events: [...a.events.values()],
        undone: [...a.undone],
      };
    }
    return { seq: this.seq, accounts };
  }

  summary() {
    const out = {};
    for (const [id, a] of this.accounts) {
      out[id] = { status: a.status, balance: a.balance, frozen: a.frozen };
    }
    return out;
  }

  getAccount(id) {
    if (!this.accounts.has(id)) this.accounts.set(id, freshAccount());
    return this.accounts.get(id);
  }

  record(acc, event) {
    this.seenIds.add(event.id);
    const stored = {
      id: event.id,
      type: event.type,
      amount: event.amount == null ? null : event.amount,
      account: event.account,
      parent: event.parent === undefined ? acc.head : event.parent,
      seq: ++this.seq,
    };
    acc.events.set(stored.id, stored);
    acc.head = stored.id;
  }

  apply(event) {
    if (!event || typeof event !== 'object' || !event.id || !event.type || !event.account) {
      this.errors.push({ eventId: event && event.id ? event.id : null, code: ERR.ILLEGAL_TRANSITION, reason: 'malformed-event' });
      return { ok: false, code: ERR.ILLEGAL_TRANSITION };
    }
    if (this.seenIds.has(event.id)) return { ok: true, duplicate: true };
    const acc = this.getAccount(event.account);
    if (event.type === 'undo') return this.applyUndo(acc, event);

    const res = transition(acc, event.type, event.amount);
    acc.status = res.state.status;
    acc.prevStatus = res.state.prevStatus;
    acc.balance = res.state.balance;
    acc.frozen = res.state.frozen;
    if (res.code) {
      this.errors.push({ eventId: event.id, account: event.account, type: event.type, code: res.code });
      return { ok: false, code: res.code };
    }
    this.record(acc, event);
    return { ok: true };
  }

  applyUndo(acc, event) {
    if (acc.status === 'ERROR') {
      this.errors.push({ eventId: event.id, account: event.account, code: ERR.ILLEGAL_TRANSITION, reason: 'error-state' });
      return { ok: false, code: ERR.ILLEGAL_TRANSITION };
    }
    if (acc.status !== 'ACTIVE') {
      acc.prevStatus = acc.status;
      acc.status = 'ERROR';
      this.errors.push({ eventId: event.id, account: event.account, code: ERR.ILLEGAL_TRANSITION });
      return { ok: false, code: ERR.ILLEGAL_TRANSITION };
    }
    const plan = event.plan || { id: 'root', targets: event.target ? [event.target] : [] };
    const markLog = [];
    const result = this.execNode(acc, plan, markLog);
    this.undoPlans.push({ eventId: event.id, account: event.account, result });
    if (result.status !== 'ok') {
      this.errors.push({
        eventId: event.id,
        account: event.account,
        code: result.error.code,
        target: result.error.target == null ? null : result.error.target,
        witness: result.error.witness == null ? null : result.error.witness,
      });
      return { ok: false, code: result.error.code, witness: result.error.witness || null };
    }
    this.record(acc, event);
    return { ok: true, plan: result };
  }

  // Hierarchical batch rollback. Children execute first (deeper layers),
  // then the node's own targets in reverse order. A failed node rolls back
  // everything it (and its children) applied; the parent decides via
  // onChildFailure: 'continue' | 'abort' (default 'abort'). Deterministic.
  execNode(acc, node, markLog) {
    const snap = { balance: acc.balance, frozen: acc.frozen, mark: markLog.length };
    const result = { id: node.id || 'node', status: 'ok', ops: [], children: [] };
    const rollback = () => {
      acc.balance = snap.balance;
      acc.frozen = snap.frozen;
      for (let i = markLog.length - 1; i >= snap.mark; i--) acc.undone.delete(markLog[i]);
      markLog.length = snap.mark;
    };

    for (const child of node.children || []) {
      const childResult = this.execNode(acc, child, markLog);
      result.children.push(childResult);
      if (childResult.status !== 'ok') {
        const policy = node.onChildFailure || 'abort';
        if (policy === 'abort') {
          rollback();
          result.status = 'failed';
          result.error = childResult.error;
          return result;
        }
      }
    }

    for (const target of [...(node.targets || [])].reverse()) {
      const r = this.undoOne(acc, target, markLog);
      if (!r.ok) {
        rollback();
        result.status = 'failed';
        result.error = { code: r.code, target, witness: r.witness || null };
        return result;
      }
      result.ops.push(r.inverse);
    }
    return result;
  }

  undoOne(acc, targetId, markLog) {
    const target = acc.events.get(targetId);
    if (!target) return { ok: false, code: ERR.ILLEGAL_TRANSITION, reason: 'unknown-target' };
    if (acc.undone.has(targetId)) return { ok: false, code: ERR.ILLEGAL_TRANSITION, reason: 'already-undone' };

    // Undoability via parent pointers: target must be an ancestor of head.
    const headChain = [];
    const ancestors = new Set();
    let cur = acc.head;
    while (cur) {
      ancestors.add(cur);
      headChain.push(cur);
      const e = acc.events.get(cur);
      cur = e ? e.parent : null;
    }
    if (!ancestors.has(targetId)) {
      const branchPath = [];
      let forkPoint = null;
      let walk = targetId;
      while (walk) {
        if (ancestors.has(walk)) { forkPoint = walk; break; }
        branchPath.push(walk);
        const e = acc.events.get(walk);
        walk = e ? e.parent : null;
      }
      const headPath = forkPoint === null
        ? headChain.slice()
        : headChain.slice(0, headChain.indexOf(forkPoint) + 1);
      return { ok: false, code: ERR.FORK_CONFLICT, witness: { forkPoint, headPath, branchPath } };
    }

    if (!UNDOABLE.has(target.type)) return { ok: false, code: ERR.ILLEGAL_TRANSITION, reason: 'not-undoable' };

    let inverse;
    switch (target.type) {
      case 'debit':
        acc.balance += target.amount;
        inverse = { op: 'credit', target: targetId, amount: target.amount };
        break;
      case 'credit':
        if (acc.balance < target.amount) return { ok: false, code: ERR.NEGATIVE };
        acc.balance -= target.amount;
        inverse = { op: 'debit', target: targetId, amount: target.amount };
        break;
      case 'hold':
        if (acc.frozen < target.amount) return { ok: false, code: ERR.HOLD_LEAK };
        acc.frozen -= target.amount;
        inverse = { op: 'release', target: targetId, amount: target.amount };
        break;
      case 'release':
        if (acc.frozen + target.amount > acc.balance) return { ok: false, code: ERR.NEGATIVE };
        acc.frozen += target.amount;
        inverse = { op: 'hold', target: targetId, amount: target.amount };
        break;
      default:
        return { ok: false, code: ERR.ILLEGAL_TRANSITION, reason: 'not-undoable' };
    }
    acc.undone.add(targetId);
    markLog.push(targetId);
    return { ok: true, inverse };
  }
}

module.exports = { Ledger };

'use strict';

class MonotonicityError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'MonotonicityError';
    this.detail = detail;
  }
}

class ToolLifeService {
  constructor({ limit, maxBudget, window = Infinity } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`invalid limit: ${limit}`);
    }
    if (!Number.isInteger(maxBudget) || maxBudget < 0) {
      throw new Error(`invalid maxBudget: ${maxBudget}`);
    }
    this.limit = limit;
    this.maxBudget = maxBudget;
    this.window = window;
    this.now = 0;
    this.currentTool = null;
    this.tools = new Map();
    this.pendingChange = null;
    this.budgetUsed = 0;
    this.seenCommands = new Set();
    this.curve = [];
    this.alarms = [];
    this.rejections = [];
    this.ignored = [];
  }

  _tool(name) {
    if (!this.tools.has(name)) {
      this.tools.set(name, { wear: 0, lastSeq: 0 });
    }
    return this.tools.get(name);
  }

  _advanceClock(op) {
    if (typeof op.t === 'number') {
      this.now = Math.max(this.now, op.t);
    } else {
      this.now += 1;
    }
  }

  apply(op) {
    this._advanceClock(op);
    switch (op.type) {
      case 'MEASURE':
        return this._measure(op);
      case 'CHANGE':
        return this._change(op);
      case 'RESET':
        return this._reset(op);
      default:
        return this._reject(op, 'UNKNOWN_TYPE', `unknown op type: ${op.type}`);
    }
  }

  applyAll(ops) {
    const results = [];
    for (const op of ops) {
      results.push(this.apply(op));
    }
    return results;
  }

  _reject(op, code, reason) {
    this.rejections.push({ op: { ...op }, code, reason, t: this.now });
    return { accepted: false, rejected: true, code, reason };
  }

  _ignore(op, code, reason) {
    this.ignored.push({ op: { ...op }, code, reason, t: this.now });
    return { accepted: false, ignored: true, code, reason };
  }

  _measure(op) {
    const { tool, wear, seq } = op;
    if (typeof tool !== 'string' || !Number.isFinite(wear) || !Number.isInteger(seq)) {
      return this._reject(op, 'MALFORMED', 'MEASURE requires tool:string, wear:number, seq:integer');
    }
    const sent = typeof op.sent === 'number' ? op.sent : this.now;
    const age = this.now - sent;
    if (age > this.window) {
      return this._ignore(op, 'EXPIRED', `expired: age ${age} > window ${this.window}`);
    }
    const state = this._tool(tool);
    if (seq <= state.lastSeq) {
      return this._ignore(op, 'STALE_SEQ', `stale seq ${seq} <= acked ${state.lastSeq}`);
    }
    if (wear < state.wear) {
      throw new MonotonicityError(
        `wear regression on ${tool}: ${state.wear} -> ${wear} (seq ${seq})`,
        { tool, from: state.wear, to: wear, seq, t: this.now }
      );
    }
    state.wear = wear;
    state.lastSeq = seq;
    if (this.pendingChange && this.pendingChange.to === tool) {
      this.pendingChange = null;
    }
    this.curve.push({ t: this.now, tool, wear, event: 'MEASURE', seq });
    if (wear >= this.limit) {
      this.alarms.push({ t: this.now, tool, wear, limit: this.limit, kind: 'LIMIT_REACHED', seq });
    }
    return { accepted: true };
  }

  _change(op) {
    const { tool, new: next, seq } = op;
    if (typeof tool !== 'string' || typeof next !== 'string' || !Number.isInteger(seq)) {
      return this._reject(op, 'MALFORMED', 'CHANGE requires tool:string, new:string, seq:integer');
    }
    const key = `CHANGE:${tool}:${seq}`;
    if (this.seenCommands.has(key)) {
      return this._ignore(op, 'DUPLICATE', `duplicate CHANGE ${key}`);
    }
    if (this.budgetUsed >= this.maxBudget) {
      return this._reject(op, 'BUDGET_EXCEEDED',
        `budget exhausted: ${this.budgetUsed}/${this.maxBudget}`);
    }
    this.seenCommands.add(key);
    const oldTool = this._tool(tool);
    oldTool.wear = 0;
    this._tool(next);
    this.currentTool = next;
    this.pendingChange = { from: tool, to: next, seq };
    this.budgetUsed += 1;
    this.curve.push({ t: this.now, tool: next, wear: 0, event: 'CHANGE', seq });
    return { accepted: true };
  }

  _reset(op) {
    const { tool, admin, seq } = op;
    if (typeof tool !== 'string' || !Number.isInteger(seq)) {
      return this._reject(op, 'MALFORMED', 'RESET requires tool:string, seq:integer');
    }
    const key = `RESET:${tool}:${seq}`;
    if (this.seenCommands.has(key)) {
      return this._ignore(op, 'DUPLICATE', `duplicate RESET ${key}`);
    }
    if (!admin) {
      return this._reject(op, 'NO_ADMIN', 'RESET requires admin authorization');
    }
    if (this.pendingChange) {
      const p = this.pendingChange;
      return this._reject(op, 'CHANGE_PENDING',
        `unconfirmed CHANGE ${p.from} -> ${p.to} (seq ${p.seq})`);
    }
    const state = this._tool(tool);
    if (state.wear < this.limit) {
      return this._reject(op, 'BELOW_LIMIT',
        `wear ${state.wear} < limit ${this.limit}`);
    }
    if (this.budgetUsed >= this.maxBudget) {
      return this._reject(op, 'BUDGET_EXCEEDED',
        `budget exhausted: ${this.budgetUsed}/${this.maxBudget}`);
    }
    this.seenCommands.add(key);
    state.wear = 0;
    this.budgetUsed += 1;
    this.curve.push({ t: this.now, tool, wear: 0, event: 'RESET', seq });
    return { accepted: true };
  }

  snapshot() {
    const tools = {};
    for (const [name, s] of this.tools) {
      tools[name] = { wear: s.wear, lastSeq: s.lastSeq };
    }
    return {
      tools,
      currentTool: this.currentTool,
      pendingChange: this.pendingChange ? { ...this.pendingChange } : null,
      budgetUsed: this.budgetUsed,
    };
  }

  report() {
    return {
      limit: this.limit,
      maxBudget: this.maxBudget,
      window: this.window === Infinity ? 'Infinity' : this.window,
      curve: this.curve,
      alarms: this.alarms,
      rejections: this.rejections,
      ignored: this.ignored,
      final: this.snapshot(),
    };
  }
}

module.exports = { ToolLifeService, MonotonicityError };

'use strict';

const { ProtocolError, BudgetError } = require('./errors');

// Budget ledger with hierarchical (nested) transactions.
//
// - Mutations are only allowed inside an open transaction frame.
// - commit() merges a frame into its parent; committing the outermost frame
//   confirms its flows into the immutable, ACKed history.
// - rollback() undoes exactly the current innermost unconfirmed frame.
//   Confirmed (ACKed) entries are never touched: with no open frame,
//   rollback() is refused.
class Ledger {
  constructor(cap) {
    if (!Number.isFinite(cap) || cap < 0) {
      throw new ProtocolError(`invalid budget cap: ${cap}`);
    }
    this.cap = cap;
    this.used = 0;
    this.jobs = new Map(); // confirmed + unconfirmed working view: id -> {id, cost, start, end, ver}
    this.entries = [];     // confirmed budget flow (ACKed history, immutable)
    this.frames = [];      // open transaction frames (unconfirmed)
    this.seq = 0;
  }

  get depth() {
    return this.frames.length;
  }

  begin() {
    this.frames.push({ flows: [], jobPrev: new Map(), usedDelta: 0 });
  }

  commit() {
    if (this.frames.length === 0) {
      throw new ProtocolError('commit refused: no open transaction');
    }
    const frame = this.frames.pop();
    if (this.frames.length > 0) {
      const parent = this.frames[this.frames.length - 1];
      parent.usedDelta += frame.usedDelta;
      parent.flows.push(...frame.flows);
      for (const [id, prev] of frame.jobPrev) {
        if (!parent.jobPrev.has(id)) parent.jobPrev.set(id, prev);
      }
    } else {
      for (const flow of frame.flows) {
        this.entries.push({ seq: ++this.seq, ...flow });
      }
    }
  }

  rollback() {
    if (this.frames.length === 0) {
      throw new ProtocolError(
        'rollback refused: no unconfirmed transaction (ACKed history is immutable)'
      );
    }
    const frame = this.frames.pop();
    const ids = [...frame.jobPrev.keys()].reverse();
    for (const id of ids) {
      const prev = frame.jobPrev.get(id);
      if (prev === null) this.jobs.delete(id);
      else this.jobs.set(id, prev);
    }
    this.used -= frame.usedDelta;
  }

  _frame() {
    if (this.frames.length === 0) {
      throw new ProtocolError('ledger mutation outside of a transaction');
    }
    return this.frames[this.frames.length - 1];
  }

  _touch(id) {
    const frame = this._frame();
    if (!frame.jobPrev.has(id)) {
      const job = this.jobs.get(id);
      frame.jobPrev.set(id, job ? { ...job } : null);
    }
  }

  occupy({ op, id, ver, cost, start = 0, end = null }) {
    const frame = this._frame();
    if (this.used + cost > this.cap) {
      throw new BudgetError(
        `budget exceeded: used ${this.used} + cost ${cost} > cap ${this.cap} (${op} ${id}@${ver})`
      );
    }
    this._touch(id);
    this.jobs.set(id, { id, cost, start, end, ver });
    this.used += cost;
    frame.usedDelta += cost;
    frame.flows.push({ op, id, ver, delta: cost, used: this.used });
  }

  release(id, { op, ver }) {
    const frame = this._frame();
    const job = this.jobs.get(id);
    if (!job) throw new ProtocolError(`${op}: unknown job ${id}`);
    this._touch(id);
    this.jobs.delete(id);
    this.used -= job.cost;
    frame.usedDelta -= job.cost;
    frame.flows.push({ op, id, ver, delta: -job.cost, used: this.used });
  }
}

module.exports = Ledger;

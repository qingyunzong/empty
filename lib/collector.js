'use strict';

const { ExitError } = require('./errors');
const { stableStringify } = require('./frame');
const { merkleRoot } = require('./merkle');

const EXIT = { FRAME: 2, DUP_CONFLICT: 3, GAP: 4, CYCLE: 5 };

function depsOf(ev) {
  const deps = [];
  if (ev.reversalOf) deps.push(ev.reversalOf);
  if (ev.replaces) deps.push(ev.replaces);
  return deps;
}

// Canonical total order for a period's events: per-acct branchSeq chains plus
// correction-link edges; among ready nodes pick smallest (logicalTs, eventId).
function canonicalOrder(events) {
  const ids = new Set(events.map((e) => e.eventId));
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const indeg = new Map(events.map((e) => [e.eventId, 0]));
  const adj = new Map(events.map((e) => [e.eventId, new Set()]));
  const addEdge = (from, to) => {
    if (!ids.has(from) || !ids.has(to) || from === to) return;
    if (adj.get(from).has(to)) return;
    adj.get(from).add(to);
    indeg.set(to, indeg.get(to) + 1);
  };
  const byAcct = new Map();
  for (const e of events) {
    if (!byAcct.has(e.acct)) byAcct.set(e.acct, []);
    byAcct.get(e.acct).push(e);
  }
  for (const list of byAcct.values()) {
    list.sort((x, y) => x.branchSeq - y.branchSeq);
    for (let i = 1; i < list.length; i++) addEdge(list[i - 1].eventId, list[i].eventId);
  }
  for (const e of events) {
    for (const d of depsOf(e)) addEdge(d, e.eventId);
  }
  const cmp = (x, y) => {
    const ex = byId.get(x);
    const ey = byId.get(y);
    return ex.logicalTs - ey.logicalTs || (x < y ? -1 : x > y ? 1 : 0);
  };
  const ready = events.filter((e) => indeg.get(e.eventId) === 0).map((e) => e.eventId).sort(cmp);
  const out = [];
  while (ready.length) {
    const id = ready.shift();
    out.push(id);
    for (const to of adj.get(id)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) {
        let i = 0;
        while (i < ready.length && cmp(ready[i], to) < 0) i++;
        ready.splice(i, 0, to);
      }
    }
  }
  if (out.length !== events.length) {
    throw new ExitError(EXIT.CYCLE, 'cyclic causality among period events');
  }
  return out;
}

class Collector {
  constructor({ gapWindow = 8 } = {}) {
    this.gapWindow = gapWindow;
    this.seen = new Map(); // eventId -> canonical payload key (dup detection)
    this.events = new Map(); // eventId -> event
    this.accts = new Map(); // acct -> { next, buffer: Map(seq->event), appliedSeq: Map(seq->eventId) }
    this.balances = new Map(); // acct -> integer
    this.applied = new Map(); // eventId -> effective amount
    this.periods = []; // closed periods
    this.currentEvents = []; // applied eventIds in the open period
    this.dupCount = 0;
    this.hooks = { beforeApply() {}, afterApply() {} };
  }

  acctState(acct) {
    if (!this.accts.has(acct)) {
      this.accts.set(acct, { next: 1, buffer: new Map(), appliedSeq: new Map() });
    }
    return this.accts.get(acct);
  }

  // Returns 'registered' or 'duplicate'. Throws ExitError on conflicts/gaps/cycles.
  register(event) {
    const key = stableStringify(event);
    const prev = this.seen.get(event.eventId);
    if (prev !== undefined) {
      if (prev === key) {
        this.dupCount++;
        return 'duplicate';
      }
      throw new ExitError(EXIT.DUP_CONFLICT, `eventId "${event.eventId}" retransmitted with a different payload`);
    }
    const a = this.acctState(event.acct);
    if (a.appliedSeq.has(event.branchSeq)) {
      throw new ExitError(EXIT.DUP_CONFLICT,
        `acct "${event.acct}" branchSeq ${event.branchSeq} already applied by event "${a.appliedSeq.get(event.branchSeq)}"`);
    }
    if (a.buffer.has(event.branchSeq)) {
      throw new ExitError(EXIT.DUP_CONFLICT,
        `acct "${event.acct}" branchSeq ${event.branchSeq} already claimed by event "${a.buffer.get(event.branchSeq).eventId}"`);
    }
    if (event.branchSeq >= a.next + this.gapWindow) {
      throw new ExitError(EXIT.GAP,
        `acct "${event.acct}" branchSeq ${event.branchSeq} beyond gap window (next expected ${a.next}, window ${this.gapWindow})`);
    }
    this.seen.set(event.eventId, key);
    this.events.set(event.eventId, event);
    a.buffer.set(event.branchSeq, event);
    this.checkCausal(event);
    this.drain();
    return 'registered';
  }

  checkCausal(event) {
    for (const dep of depsOf(event)) {
      if (dep === event.eventId) {
        throw new ExitError(EXIT.CYCLE, `event "${event.eventId}" references itself`);
      }
      const target = this.events.get(dep);
      if (target && target.acct === event.acct && target.branchSeq > event.branchSeq) {
        throw new ExitError(EXIT.CYCLE,
          `causal cycle: "${event.eventId}" (seq ${event.branchSeq}) depends on "${dep}" (seq ${target.branchSeq}) of the same acct`);
      }
      if (this.dependsOn(dep, event.eventId, new Set())) {
        throw new ExitError(EXIT.CYCLE, `causal cycle detected: "${dep}" transitively depends on "${event.eventId}"`);
      }
    }
    for (const other of this.events.values()) {
      if (other.acct === event.acct && other.branchSeq < event.branchSeq && depsOf(other).includes(event.eventId)) {
        throw new ExitError(EXIT.CYCLE,
          `causal cycle: "${other.eventId}" (seq ${other.branchSeq}) depends on later seq ${event.branchSeq} of the same acct`);
      }
    }
  }

  dependsOn(fromId, targetId, visited) {
    if (fromId === targetId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    const ev = this.events.get(fromId);
    if (!ev) return false;
    return depsOf(ev).some((d) => this.dependsOn(d, targetId, visited));
  }

  depsReady(ev) {
    return depsOf(ev).every((d) => this.applied.has(d));
  }

  drain() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const a of this.accts.values()) {
        while (a.buffer.has(a.next)) {
          const ev = a.buffer.get(a.next);
          if (!this.depsReady(ev)) break;
          this.apply(ev);
          progress = true;
        }
      }
    }
  }

  apply(ev) {
    const a = this.accts.get(ev.acct);
    a.buffer.delete(ev.branchSeq);
    this.hooks.beforeApply(ev);
    const eff = ev.reversalOf ? -this.applied.get(ev.reversalOf) : ev.amount;
    this.applied.set(ev.eventId, eff);
    a.appliedSeq.set(ev.branchSeq, ev.eventId);
    a.next = ev.branchSeq + 1;
    this.balances.set(ev.acct, (this.balances.get(ev.acct) || 0) + eff);
    this.currentEvents.push(ev.eventId);
    this.hooks.afterApply(ev);
  }

  // Freezes the open period. Returns the period record, or null if empty.
  close() {
    if (this.currentEvents.length === 0) return null;
    const order = canonicalOrder(this.currentEvents.map((id) => this.events.get(id)));
    const certEvents = order.map((id) => Object.assign({}, this.events.get(id), { effective: this.applied.get(id) }));
    const period = {
      id: this.periods.length + 1,
      events: order,
      certEvents,
      merkleRoot: merkleRoot(certEvents),
      balances: Object.fromEntries([...this.balances.entries()].sort()),
      prevRoot: this.periods.length ? this.periods[this.periods.length - 1].merkleRoot : null,
    };
    this.periods.push(period);
    this.currentEvents = [];
    return period;
  }

  pending() {
    const out = [];
    for (const [acct, a] of [...this.accts.entries()].sort()) {
      const seqs = [...a.buffer.keys()].sort((x, y) => x - y);
      for (const seq of seqs) {
        const ev = a.buffer.get(seq);
        const missing = depsOf(ev).filter((d) => !this.applied.has(d));
        let reason;
        if (seq !== a.next) reason = `waiting for seq ${a.next}`;
        else if (missing.length) reason = `waiting for ${missing.join(', ')}`;
        else reason = 'queued';
        out.push({ acct, branchSeq: seq, eventId: ev.eventId, reason });
      }
    }
    return out;
  }

  toJSON(walFrames) {
    return {
      version: 1,
      walFrames,
      gapWindow: this.gapWindow,
      dupCount: this.dupCount,
      seen: [...this.seen],
      events: [...this.events],
      accts: [...this.accts].map(([k, v]) => [k, { next: v.next, buffer: [...v.buffer], appliedSeq: [...v.appliedSeq] }]),
      balances: [...this.balances],
      applied: [...this.applied],
      periods: this.periods,
      currentEvents: this.currentEvents,
    };
  }

  static fromJSON(s) {
    const c = new Collector({ gapWindow: s.gapWindow });
    c.dupCount = s.dupCount;
    c.seen = new Map(s.seen);
    c.events = new Map(s.events);
    c.accts = new Map(s.accts.map(([k, v]) => [k, { next: v.next, buffer: new Map(v.buffer), appliedSeq: new Map(v.appliedSeq) }]));
    c.balances = new Map(s.balances);
    c.applied = new Map(s.applied);
    c.periods = s.periods;
    c.currentEvents = s.currentEvents;
    return c;
  }
}

module.exports = { Collector, canonicalOrder, depsOf, EXIT };

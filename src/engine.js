// Precedence propagation engine.
//
// Events are mapped onto a finite ordinal domain (positions 0..n-1 of the
// linearization). Hard "happens-before" edges are propagated from:
//   - vector clocks:  vc(a) < vc(b)  =>  a precedes b
//   - time windows:   ts(b) - ts(a) > maxSkewMs  =>  a precedes b
//
// The engine supports incremental updates: addEvent derives edges against all
// existing events; retractEvent removes exactly the facts justified by the
// retracted event. A trail (begin/addDecisionEdge/rollback) lets the search
// layer speculate and restore propagation state / search nodes cheaply.

import { compareVectorClocks } from './event.js';

const SEP = '';

export class PrecedenceEngine {
  constructor({ maxSkewMs = 30000 } = {}) {
    this.maxSkewMs = maxSkewMs;
    this.events = new Map();      // id -> event
    this.baseEdges = new Map();   // key -> { from, to, rules: Set<string> }
    this.trialEdges = new Map();  // decision edges added during search
    this.trialLog = [];           // rollback log: { key, added }
    this.version = 0;             // bumped on every mutation; invalidates closure cache
    this._closure = null;
    this._closureVersion = -1;
  }

  _key(from, to) {
    return from + SEP + to;
  }

  _derivePair(a, b) {
    const out = [];
    const cmp = compareVectorClocks(a.vc, b.vc);
    if (cmp === -1) out.push({ from: a.id, to: b.id, rule: 'vector-clock' });
    else if (cmp === 1) out.push({ from: b.id, to: a.id, rule: 'vector-clock' });
    if (b.ts - a.ts > this.maxSkewMs) out.push({ from: a.id, to: b.id, rule: 'time-window' });
    else if (a.ts - b.ts > this.maxSkewMs) out.push({ from: b.id, to: a.id, rule: 'time-window' });
    return out;
  }

  _addBaseEdge(from, to, rule) {
    const key = this._key(from, to);
    const existing = this.baseEdges.get(key);
    if (existing) existing.rules.add(rule);
    else this.baseEdges.set(key, { from, to, rules: new Set([rule]) });
  }

  addEvent(event) {
    if (this.events.has(event.id)) {
      throw new Error(`engine: duplicate event id ${event.id}`);
    }
    for (const other of this.events.values()) {
      for (const edge of this._derivePair(other, event)) {
        this._addBaseEdge(edge.from, edge.to, edge.rule);
      }
    }
    this.events.set(event.id, event);
    this.version++;
  }

  // Incremental undo of everything the retracted event justified.
  retractEvent(id) {
    if (!this.events.has(id)) return false;
    this.events.delete(id);
    for (const [key, edge] of this.baseEdges) {
      if (edge.from === id || edge.to === id) this.baseEdges.delete(key);
    }
    for (const [key, edge] of this.trialEdges) {
      if (edge.from === id || edge.to === id) this.trialEdges.delete(key);
    }
    this.trialLog = this.trialLog.filter((entry) => this.trialEdges.has(entry.key));
    this.version++;
    return true;
  }

  // --- trail (speculative propagation used by the search layer) ---

  begin() {
    return this.trialLog.length;
  }

  addDecisionEdge(from, to, rule = 'decision') {
    const key = this._key(from, to);
    if (this.baseEdges.has(key) || this.trialEdges.has(key)) {
      this.trialLog.push({ key, added: false });
      return false;
    }
    this.trialEdges.set(key, { from, to, rules: new Set([rule]) });
    this.trialLog.push({ key, added: true });
    this.version++;
    return true;
  }

  rollback(mark) {
    while (this.trialLog.length > mark) {
      const entry = this.trialLog.pop();
      if (entry.added) this.trialEdges.delete(entry.key);
    }
    this.version++;
  }

  // --- queries ---

  *edges() {
    yield* this.baseEdges.values();
    yield* this.trialEdges.values();
  }

  edgeBetween(from, to) {
    return this.baseEdges.get(this._key(from, to)) ?? this.trialEdges.get(this._key(from, to)) ?? null;
  }

  _computeClosure() {
    if (this._closureVersion === this.version) return this._closure;
    const adj = new Map();
    for (const id of this.events.keys()) adj.set(id, []);
    for (const edge of this.edges()) adj.get(edge.from)?.push(edge.to);
    const reach = new Map();
    for (const id of this.events.keys()) {
      const seen = new Set();
      const stack = [id];
      while (stack.length > 0) {
        const cur = stack.pop();
        for (const nxt of adj.get(cur) ?? []) {
          if (!seen.has(nxt)) {
            seen.add(nxt);
            stack.push(nxt);
          }
        }
      }
      reach.set(id, seen);
    }
    this._closure = reach;
    this._closureVersion = this.version;
    return reach;
  }

  reaches(from, to) {
    if (from === to) return false;
    return this._computeClosure().get(from)?.has(to) ?? false;
  }

  // Find one cycle in the current graph; returns node ids [x, ..., x] or null.
  findCycle() {
    const adj = new Map();
    for (const id of this.events.keys()) adj.set(id, []);
    for (const edge of this.edges()) adj.get(edge.from)?.push(edge.to);
    const color = new Map(); // 0/undefined white, 1 gray, 2 black
    const stack = [];
    const dfs = (node) => {
      color.set(node, 1);
      stack.push(node);
      for (const nxt of adj.get(node) ?? []) {
        const c = color.get(nxt) ?? 0;
        if (c === 0) {
          const found = dfs(nxt);
          if (found) return found;
        } else if (c === 1) {
          return [...stack.slice(stack.indexOf(nxt)), nxt];
        }
      }
      stack.pop();
      color.set(node, 2);
      return null;
    };
    for (const id of adj.keys()) {
      if ((color.get(id) ?? 0) === 0) {
        const found = dfs(id);
        if (found) return found;
      }
    }
    return null;
  }
}

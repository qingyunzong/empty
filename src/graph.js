import { LotError, EXIT } from './errors.js';
import { canonical, sha256hex } from './canon.js';

const EPS = 1e-9;

export function entryId(entry) {
  const { id, ...rest } = entry;
  return sha256hex(canonical(rest));
}

// Directed acyclic graph of lots. Nodes are lots, edges are consume/produce
// relations captured by merge/split/relabel operations.
export class Graph {
  constructor({ tolerance = 0.005 } = {}) {
    this.tolerance = tolerance;
    this.lots = new Map(); // id -> { mass, remaining, createdTs, status }
    this.edges = []; // { from, to, mass, op }
    this.ops = new Map(); // entry id -> entry
    this.pending = []; // entries waiting for unknown parent lots
    this.pendingIds = new Set();
    this.vv = {}; // site -> max seq seen
    this.lastTs = 0;
  }

  has(id) {
    return this.ops.has(id) || this.pendingIds.has(id);
  }

  pathExists(from, to) {
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e.to);
    }
    const stack = [from];
    const seen = new Set([from]);
    while (stack.length) {
      const cur = stack.pop();
      if (cur === to) return true;
      for (const nxt of adj.get(cur) || []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return false;
  }

  // Validate without mutating. Returns 'apply' | 'pending' | 'duplicate'.
  // Throws LotError(VALIDATION) on hard violations.
  check(entry) {
    if (this.ops.has(entry.id)) return 'duplicate';
    if (!entry.op || !Array.isArray(entry.out) || entry.out.length === 0)
      throw new LotError(EXIT.VALIDATION, 'entry must have op and non-empty out');
    if (entry.op === 'register') {
      if (entry.out.length !== 1)
        throw new LotError(EXIT.VALIDATION, 'register requires exactly 1 output');
      if (this.lots.has(entry.out[0].lot))
        throw new LotError(EXIT.VALIDATION, `lot ${entry.out[0].lot} already registered`);
      return 'apply';
    }
    if (!['merge', 'split', 'relabel'].includes(entry.op))
      throw new LotError(EXIT.VALIDATION, `unknown op ${entry.op}`);
    if (!Array.isArray(entry.in) || entry.in.length === 0)
      throw new LotError(EXIT.VALIDATION, `${entry.op} requires inputs`);
    for (const inp of entry.in) {
      if (!this.lots.has(inp.lot)) return 'pending'; // unknown parent: pend, never fail
    }
    for (const inp of entry.in) {
      const lot = this.lots.get(inp.lot);
      if (lot.status !== 'open')
        throw new LotError(EXIT.VALIDATION, `lot ${inp.lot} not open (status=${lot.status})`);
      if (inp.mass > lot.remaining + EPS)
        throw new LotError(EXIT.VALIDATION, `lot ${inp.lot} insufficient mass: have ${lot.remaining}, need ${inp.mass}`);
      if (entry.ts < lot.createdTs)
        throw new LotError(EXIT.VALIDATION, `op ts ${entry.ts} precedes creation of lot ${inp.lot} at ${lot.createdTs}`);
    }
    const sumIn = entry.in.reduce((a, b) => a + b.mass, 0);
    const sumOut = entry.out.reduce((a, b) => a + b.mass, 0);
    if (Math.abs(sumIn - sumOut) > Math.max(EPS, this.tolerance * sumIn))
      throw new LotError(EXIT.VALIDATION, `mass not conserved: in=${sumIn} out=${sumOut} tolerance=${this.tolerance}`);
    if (entry.op === 'merge' && entry.in.length < 2)
      throw new LotError(EXIT.VALIDATION, 'merge requires >= 2 inputs');
    if (entry.op === 'split' && entry.out.length < 2)
      throw new LotError(EXIT.VALIDATION, 'split requires >= 2 outputs');
    if (entry.op === 'relabel' && (entry.in.length !== 1 || entry.out.length !== 1))
      throw new LotError(EXIT.VALIDATION, 'relabel requires exactly 1 input and 1 output');
    for (const o of entry.out) {
      for (const i of entry.in) {
        if (o.lot === i.lot || this.pathExists(o.lot, i.lot))
          throw new LotError(EXIT.VALIDATION, `cycle rejected: ${o.lot} reaches ${i.lot}`);
      }
      if (this.lots.has(o.lot))
        throw new LotError(EXIT.VALIDATION, `output lot ${o.lot} already exists`);
    }
    return 'apply';
  }

  apply(entry) {
    if (this.pendingIds.has(entry.id)) return 'duplicate'; // already queued
    const verdict = this.check(entry);
    if (verdict === 'duplicate') return 'duplicate';
    this.#bumpVV(entry);
    if (verdict === 'pending') {
      this.pending.push(entry);
      this.pendingIds.add(entry.id);
      return 'pending';
    }
    this.#mutate(entry);
    this.drainPending();
    return 'applied';
  }

  // Replay entries, never throwing on LotError; returns collected errors.
  replay(entries) {
    const errors = [];
    for (const e of entries) {
      try {
        this.apply(e);
      } catch (err) {
        if (err instanceof LotError) {
          errors.push({ entry: e, error: err.message, code: err.code });
          this.pendingIds.add(e.id);
        } else throw err;
      }
    }
    return errors;
  }

  drainPending() {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.pending.length; i++) {
        const e = this.pending[i];
        let verdict;
        try {
          verdict = this.check(e);
        } catch {
          continue; // becomes invalid only when parents arrive wrong; keep pending
        }
        if (verdict === 'apply') {
          this.pending.splice(i, 1);
          this.pendingIds.delete(e.id);
          this.#mutate(e);
          progress = true;
          i--;
        } else if (verdict === 'duplicate') {
          this.pending.splice(i, 1);
          this.pendingIds.delete(e.id);
          i--;
          progress = true;
        }
      }
    }
  }

  #bumpVV(entry) {
    if (entry.site && typeof entry.seq === 'number') {
      this.vv[entry.site] = Math.max(this.vv[entry.site] || 0, entry.seq);
    }
    if (typeof entry.ts === 'number') this.lastTs = Math.max(this.lastTs, entry.ts);
  }

  #mutate(entry) {
    if (entry.op === 'register') {
      const o = entry.out[0];
      this.lots.set(o.lot, { mass: o.mass, remaining: o.mass, createdTs: entry.ts, status: 'open' });
    } else {
      for (const inp of entry.in) {
        const lot = this.lots.get(inp.lot);
        lot.remaining = Math.max(0, lot.remaining - inp.mass);
        if (lot.remaining <= EPS) lot.status = 'consumed';
      }
      for (const o of entry.out) {
        this.lots.set(o.lot, { mass: o.mass, remaining: o.mass, createdTs: entry.ts, status: 'open' });
      }
      for (const inp of entry.in) {
        for (const o of entry.out) {
          this.edges.push({ from: inp.lot, to: o.lot, mass: inp.mass, op: entry.id });
        }
      }
    }
    this.ops.set(entry.id, entry);
  }

  // All lots reachable backwards from root (inclusive).
  ancestors(root) {
    const back = new Map();
    for (const e of this.edges) {
      if (!back.has(e.to)) back.set(e.to, []);
      back.get(e.to).push(e.from);
    }
    const out = new Set();
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (out.has(cur)) continue;
      out.add(cur);
      for (const p of back.get(cur) || []) stack.push(p);
    }
    return out;
  }

  ancestorOps(root) {
    const anc = this.ancestors(root);
    const ops = [];
    for (const entry of this.ops.values()) {
      if (entry.op !== 'register' && entry.out.some((o) => anc.has(o.lot))) ops.push(entry);
      else if (entry.op === 'register' && anc.has(entry.out[0].lot)) ops.push(entry);
    }
    return ops.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  }

  // Enumerate every ancestor path of root, source lot first. Top-down DFS.
  enumeratePaths(root) {
    const back = new Map();
    for (const e of this.edges) {
      if (!back.has(e.to)) back.set(e.to, []);
      back.get(e.to).push(e.from);
    }
    const paths = [];
    const visit = (node, suffix) => {
      const parents = back.get(node) || [];
      if (parents.length === 0) {
        paths.push([node, ...suffix]);
        return;
      }
      for (const p of parents) visit(p, [node, ...suffix]);
    };
    visit(root, []);
    return paths;
  }
}

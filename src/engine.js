'use strict';

const { getRule } = require('./rules');
const { matchComponent, edgeExists } = require('./matcher');
const { buildCluster } = require('./clusters');

class ReconError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReconError';
  }
}

function keyOf(kind, id) {
  return (kind === 'internal' ? 'I:' : 'E:') + id;
}

function toCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new ReconError(`invalid amount: ${amount}`);
  }
  return Math.round(amount * 100);
}

function toMs(ts) {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new ReconError(`invalid timestamp: ${ts}`);
  return ms;
}

function addEdge(adj, a, b) {
  let sa = adj.get(a);
  if (!sa) adj.set(a, (sa = new Set()));
  sa.add(b);
  let sb = adj.get(b);
  if (!sb) adj.set(b, (sb = new Set()));
  sb.add(a);
}

class Engine {
  constructor({ rulesVersion = 'v1' } = {}) {
    this.rule = getRule(rulesVersion);
    this.rows = new Map(); // key -> {key, kind, id, amountCents, tsMs, revoked}
    this.history = []; // revoked matches are preserved here
    this.seq = 0;
    this.events = [];
    this.adj = new Map(); // candidate-edge adjacency over active rows
    this.clusters = new Map(); // cluster id -> cluster
    this.rowCluster = new Map(); // row key -> cluster id
    this.dirty = new Set();
  }

  apply(event) {
    if (!event || typeof event !== 'object') throw new ReconError('event must be an object');
    const seq = ++this.seq;
    this._apply(event, seq);
    this.events.push({ seq, ...event });
    this.recompute();
    return seq;
  }

  _apply(event, seq) {
    switch (event.type) {
      case 'internal':
      case 'external':
        this._addRow(event);
        break;
      case 'revoke':
        this._revoke(event, seq);
        break;
      case 'correct':
        this._correct(event);
        break;
      case 'rule':
        this._switchRule(event);
        break;
      default:
        throw new ReconError(`unknown event type: ${event.type}`);
    }
  }

  _addRow(event) {
    const kind = event.type;
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new ReconError('row id must be a non-empty string');
    }
    const key = keyOf(kind, event.id);
    if (this.rows.has(key)) throw new ReconError(`duplicate row id: ${event.id}`);
    const row = {
      key,
      kind,
      id: event.id,
      amountCents: toCents(event.amount),
      tsMs: toMs(event.ts),
      revoked: false,
    };
    this.rows.set(key, row);
    this.dirty.add(key);
  }

  _revoke(event, seq) {
    const key = keyOf('external', event.id);
    const row = this.rows.get(key);
    if (!row) throw new ReconError(`cannot revoke unknown external row: ${event.id}`);
    if (row.revoked) throw new ReconError(`external row already revoked: ${event.id}`);
    // Release internal partners; keep the historical match record.
    const released = [];
    const cid = this.rowCluster.get(key);
    const cluster = cid ? this.clusters.get(cid) : null;
    if (cluster) {
      for (const p of cluster.matches.pairs) {
        if (p.external === key) released.push(p.internal);
      }
      for (const g of cluster.matches.groups) {
        if (g.external === key) released.push(...g.members);
      }
    }
    this.history.push({
      seq,
      type: 'REVOKED_MATCH',
      external: key,
      releasedInternals: released.sort(),
      clusterId: cid || null,
    });
    row.revoked = true;
    this.dirty.add(key);
  }

  _correct(event) {
    const side = event.side || 'external';
    if (side !== 'internal' && side !== 'external') {
      throw new ReconError(`invalid side: ${side}`);
    }
    const key = keyOf(side, event.id);
    const row = this.rows.get(key);
    if (!row) throw new ReconError(`cannot correct unknown row: ${event.id}`);
    if (row.revoked) throw new ReconError(`cannot correct revoked row: ${event.id}`);
    row.amountCents = toCents(event.amount);
    this.dirty.add(key);
  }

  _switchRule(event) {
    const rule = getRule(event.version); // validates
    if (rule.version === this.rule.version) return;
    this.rule = rule;
    // Rule switch cascades: every candidate edge and match is re-evaluated.
    for (const [key, row] of this.rows) {
      if (!row.revoked) this.dirty.add(key);
    }
  }

  // Incremental recompute: only rows reachable from the dirty set (through old
  // cluster membership or new candidate edges) are re-evaluated; invalidation
  // propagates to the whole affected cluster.
  recompute() {
    if (this.dirty.size === 0) return;
    const dirty = [...this.dirty];
    this.dirty.clear();

    for (const key of dirty) {
      const neighbors = this.adj.get(key);
      if (neighbors) {
        for (const n of neighbors) {
          const sn = this.adj.get(n);
          if (sn) sn.delete(key);
        }
        this.adj.delete(key);
      }
    }
    const isActive = (key) => {
      const row = this.rows.get(key);
      return row && !row.revoked;
    };
    for (const key of dirty) {
      if (!isActive(key)) continue;
      const row = this.rows.get(key);
      for (const [otherKey, other] of this.rows) {
        if (otherKey === key || other.revoked) continue;
        if (edgeExists(row, other, this.rule)) addEdge(this.adj, key, otherKey);
      }
    }

    const affected = new Set(dirty.filter(isActive));
    const pullCluster = (key) => {
      const cid = this.rowCluster.get(key);
      if (!cid) return;
      const cluster = this.clusters.get(cid);
      if (!cluster) return;
      for (const m of cluster.memberKeys) {
        if (isActive(m)) affected.add(m);
      }
    };
    for (const key of dirty) pullCluster(key);
    for (const key of [...affected]) {
      for (const n of this.adj.get(key) || []) pullCluster(n);
    }

    for (const key of new Set([...dirty, ...affected])) {
      const cid = this.rowCluster.get(key);
      if (cid && this.clusters.has(cid)) {
        for (const m of this.clusters.get(cid).memberKeys) this.rowCluster.delete(m);
        this.clusters.delete(cid);
      }
    }

    const seen = new Set();
    for (const start of affected) {
      if (seen.has(start)) continue;
      const component = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const key = stack.pop();
        component.push(key);
        for (const n of this.adj.get(key) || []) {
          if (affected.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      const rows = component.map((k) => this.rows.get(k));
      const cluster = buildCluster(rows, matchComponent(rows, this.rule));
      this.clusters.set(cluster.id, cluster);
      for (const m of cluster.memberKeys) this.rowCluster.set(m, cluster.id);
    }
  }

  recomputeAll() {
    this.adj = new Map();
    this.clusters = new Map();
    this.rowCluster = new Map();
    this.dirty = new Set();
    for (const [key, row] of this.rows) {
      if (!row.revoked) this.dirty.add(key);
    }
    this.recompute();
  }

  getAllClusters() {
    return [...this.clusters.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  getDifferenceClusters() {
    return this.getAllClusters().filter((c) => c.status !== 'SETTLED');
  }

  getSuggestions() {
    const out = [];
    for (const c of this.getDifferenceClusters()) {
      for (const s of c.suggestions) out.push({ cluster: c.id, ...s });
    }
    return out;
  }

  toSnapshot() {
    return {
      seq: this.seq,
      rulesVersion: this.rule.version,
      rows: [...this.rows.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
      history: this.history,
      events: this.events,
    };
  }

  static fromSnapshot(snapshot) {
    const engine = new Engine({ rulesVersion: snapshot.rulesVersion });
    engine.seq = snapshot.seq;
    for (const row of snapshot.rows) engine.rows.set(row.key, { ...row });
    engine.history = snapshot.history;
    engine.events = snapshot.events;
    engine.recomputeAll();
    return engine;
  }
}

module.exports = { Engine, ReconError };

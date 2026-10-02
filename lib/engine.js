'use strict';

const crypto = require('node:crypto');
const { canonical } = require('./canonical');

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNKNOWN = 'UNKNOWN';

function combine(parts) {
  if (parts.includes(FAIL)) return FAIL;
  if (parts.includes(UNKNOWN)) return UNKNOWN;
  return PASS;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// An edge propagates only when its valid-time interval covers the
// production window of the consuming (downstream) lot.
function edgeCoversWindow(edge, lot) {
  const window = lot.window || {};
  if (window.start && edge.valid_from && edge.valid_from > window.start) return false;
  if (window.end && edge.valid_to && edge.valid_to < window.end) return false;
  return true;
}

function topoSort(lots, downstream) {
  const indegree = new Map();
  for (const id of lots.keys()) indegree.set(id, 0);
  for (const edges of downstream.values()) {
    for (const e of edges) indegree.set(e.to, indegree.get(e.to) + 1);
  }
  const ready = [...lots.keys()].filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const e of downstream.get(id)) {
      indegree.set(e.to, indegree.get(e.to) - 1);
      if (indegree.get(e.to) === 0) {
        const at = ready.findIndex((x) => x > e.to);
        if (at === -1) ready.push(e.to);
        else ready.splice(at, 0, e.to);
      }
    }
  }
  return order;
}

class Engine {
  constructor({ lots, edges, tests }) {
    this.lots = lots; // Map id -> lot
    this.edges = edges; // Map id -> edge
    this.tests = tests; // Map id -> test
    this.revokedTests = new Set();
    this.testsByLot = new Map();
    for (const t of tests.values()) {
      if (!this.testsByLot.has(t.lot)) this.testsByLot.set(t.lot, []);
      this.testsByLot.get(t.lot).push(t);
    }
    this.upstream = new Map();
    this.downstream = new Map();
    for (const id of lots.keys()) {
      this.upstream.set(id, []);
      this.downstream.set(id, []);
    }
    for (const e of edges.values()) {
      this.upstream.get(e.to).push(e);
      this.downstream.get(e.from).push(e);
    }
    this.topoOrder = topoSort(this.lots, this.downstream);
    this.statusCache = new Map();
    this.hashCache = new Map();
    this.certLog = [];
    this.currentCerts = new Map();
  }

  isProduct(id) {
    return this.downstream.get(id).length === 0;
  }

  statusOf(id) {
    return this.statusCache.get(id);
  }

  certificateHashOf(id) {
    return this.hashCache.get(id);
  }

  ownStatus(id) {
    const active = (this.testsByLot.get(id) || []).filter((t) => !this.revokedTests.has(t.id));
    if (active.some((t) => t.result === 'fail')) return FAIL;
    if (active.length === 0) return UNKNOWN;
    return PASS;
  }

  computeStatus(id) {
    const lot = this.lots.get(id);
    const parts = [this.ownStatus(id)];
    for (const e of this.upstream.get(id)) {
      if (edgeCoversWindow(e, lot)) parts.push(this.statusCache.get(e.from));
    }
    return combine(parts);
  }

  evidenceOf(id) {
    const seen = new Set();
    const found = new Set();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const t of this.testsByLot.get(cur) || []) {
        if (!this.revokedTests.has(t.id)) found.add(t.id);
      }
      const lot = this.lots.get(cur);
      for (const e of this.upstream.get(cur)) {
        if (edgeCoversWindow(e, lot)) stack.push(e.from);
      }
    }
    return found;
  }

  computeHash(id) {
    const lot = this.lots.get(id);
    const inputs = [];
    for (const e of this.upstream.get(id)) {
      if (edgeCoversWindow(e, lot)) inputs.push(this.hashCache.get(e.from));
    }
    inputs.sort();
    const evidence = [...this.evidenceOf(id)].sort();
    return sha256(canonical({ lot: id, status: this.statusCache.get(id), evidence, inputs }));
  }

  computeInitial() {
    for (const id of this.topoOrder) this.statusCache.set(id, this.computeStatus(id));
    for (const id of this.topoOrder) this.hashCache.set(id, this.computeHash(id));
    for (const id of this.topoOrder) {
      if (this.isProduct(id)) this.issueCertificate(id);
    }
  }

  issueCertificate(id) {
    const hash = this.hashCache.get(id);
    const prev = this.currentCerts.get(id);
    if (prev) {
      prev.revoked = true;
      prev.superseded_by = hash;
    }
    const entry = {
      seq: this.certLog.length,
      lot: id,
      status: this.statusCache.get(id),
      hash,
      revoked: false,
      superseded_by: null,
    };
    this.certLog.push(entry);
    this.currentCerts.set(id, entry);
    return entry;
  }

  descendantsOf(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const e of this.downstream.get(cur)) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    return seen;
  }

  // Incremental recompute: only the downstream cone of the correction
  // target is dirty; everything else keeps its cached status/hash.
  applyCorrection(corr) {
    let dirty;
    if (corr.type === 'revoke_test') {
      const t = this.tests.get(corr.test_id);
      this.revokedTests.add(t.id);
      dirty = this.descendantsOf(t.lot);
    } else if (corr.type === 'update_edge') {
      const e = this.edges.get(corr.edge_id);
      if (corr.valid_from !== undefined) e.valid_from = corr.valid_from;
      if (corr.valid_to !== undefined) e.valid_to = corr.valid_to;
      dirty = this.descendantsOf(e.to);
    } else {
      throw new Error(`unknown correction type: ${corr.type}`);
    }
    for (const id of this.topoOrder) {
      if (dirty.has(id)) this.statusCache.set(id, this.computeStatus(id));
    }
    for (const id of this.topoOrder) {
      if (dirty.has(id)) this.hashCache.set(id, this.computeHash(id));
    }
    const changed = [];
    for (const id of this.topoOrder) {
      if (!dirty.has(id) || !this.isProduct(id)) continue;
      const current = this.currentCerts.get(id);
      if (!current || current.hash !== this.hashCache.get(id)) {
        this.issueCertificate(id);
        changed.push(id);
      }
    }
    return { affected: [...dirty].sort(), changed };
  }

  products() {
    return [...this.lots.keys()]
      .filter((id) => this.isProduct(id))
      .sort()
      .map((id) => ({
        lot: id,
        status: this.statusCache.get(id),
        certificate_hash: this.hashCache.get(id),
      }));
  }
}

module.exports = { Engine, edgeCoversWindow, combine, topoSort, PASS, FAIL, UNKNOWN };

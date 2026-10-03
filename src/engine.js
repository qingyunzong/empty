'use strict';

const { canonicalize, sha256hex } = require('./canon');

const LOT_TYPES = new Set(['raw_material', 'intermediate', 'finished_good']);

function parseTime(value) {
  if (value === undefined || value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NaN : ms;
}

function edgeKey(from, to) {
  return from + '->' + to;
}

// Incremental lineage engine.
//
// Semantics:
//  - A lot is FAIL when a non-revoked failing test reaches it: its own test,
//    or one propagated from an upstream lot through an edge whose validity
//    window fully covers this lot's production window.
//  - A lot is PASS when it is not FAIL and it has direct passing evidence,
//    or all of its direct inputs are PASS (structural, not time-gated).
//  - Otherwise the lot is UNKNOWN: evidence is missing. UNKNOWN is never
//    treated as FAIL.
class Engine {
  constructor({ lots, edges, tests }) {
    this.errors = [];
    this.lots = new Map();
    this.edges = new Map();
    this.upstreams = new Map();
    this.downstreams = new Map();
    this.tests = new Map();
    this.testsByLot = new Map();
    this.state = new Map();
    this.certs = new Map();
    this.certLog = [];
    this.topo = [];
    this.stats = { lotsRecomputed: 0, correctionsApplied: 0 };

    if (!Array.isArray(lots)) {
      this.errors.push({ error: 'invalid_lots', message: 'lots.json must contain a JSON array' });
      lots = [];
    }
    this._loadLots(lots);
    this._loadEdges(Array.isArray(edges) ? edges : []);
    this._loadTests(Array.isArray(tests) ? tests : []);
    if (this.errors.length === 0) this._topoSort();
  }

  _loadLots(lots) {
    for (const raw of lots) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') {
        this.errors.push({ error: 'invalid_lot', message: 'every lot needs a non-empty string id' });
        continue;
      }
      if (this.lots.has(raw.id)) {
        this.errors.push({ error: 'duplicate_lot', message: `duplicate lot id ${raw.id}` });
        continue;
      }
      if (!LOT_TYPES.has(raw.type)) {
        this.errors.push({ error: 'invalid_lot_type', message: `lot ${raw.id} has unknown type ${String(raw.type)}` });
        continue;
      }
      const start = parseTime(raw.production_start);
      const end = parseTime(raw.production_end);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        this.errors.push({ error: 'invalid_time', message: `lot ${raw.id} has an unparseable production window` });
        continue;
      }
      if (start !== null && end !== null && start > end) {
        this.errors.push({ error: 'invalid_window', message: `lot ${raw.id} production_start is after production_end` });
        continue;
      }
      this.lots.set(raw.id, { id: raw.id, type: raw.type, start, end });
      this.upstreams.set(raw.id, []);
      this.downstreams.set(raw.id, []);
      this.testsByLot.set(raw.id, []);
    }
  }

  _loadEdges(edges) {
    for (const raw of edges) {
      if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
        this.errors.push({ error: 'invalid_edge', message: 'every edge needs string from/to' });
        continue;
      }
      if (!this.lots.has(raw.from) || !this.lots.has(raw.to)) {
        const missing = [raw.from, raw.to].filter((id) => !this.lots.has(id));
        this.errors.push({ error: 'unknown_lot', message: `edge ${raw.from} -> ${raw.to} references unknown lot(s): ${missing.join(', ')}` });
        continue;
      }
      const key = edgeKey(raw.from, raw.to);
      if (this.edges.has(key)) {
        this.errors.push({ error: 'duplicate_edge', message: `duplicate edge ${key}` });
        continue;
      }
      const validFrom = parseTime(raw.valid_from);
      const validTo = parseTime(raw.valid_to);
      if (Number.isNaN(validFrom) || Number.isNaN(validTo)) {
        this.errors.push({ error: 'invalid_time', message: `edge ${key} has an unparseable validity window` });
        continue;
      }
      if (validFrom !== null && validTo !== null && validFrom > validTo) {
        this.errors.push({ error: 'invalid_window', message: `edge ${key} valid_from is after valid_to` });
        continue;
      }
      const edge = { from: raw.from, to: raw.to, validFrom, validTo };
      this.edges.set(key, edge);
      this.upstreams.get(raw.to).push({ from: raw.from, edge });
      this.downstreams.get(raw.from).push(raw.to);
    }
  }

  _loadTests(tests) {
    for (const raw of tests) {
      if (!raw || typeof raw.id !== 'string' || raw.id === '') {
        this.errors.push({ error: 'invalid_test', message: 'every test needs a non-empty string id' });
        continue;
      }
      if (this.tests.has(raw.id)) {
        this.errors.push({ error: 'duplicate_test', message: `duplicate test id ${raw.id}` });
        continue;
      }
      if (!this.lots.has(raw.lot)) {
        this.errors.push({ error: 'unknown_lot', message: `test ${raw.id} references unknown lot ${String(raw.lot)}` });
        continue;
      }
      if (raw.result !== 'pass' && raw.result !== 'fail') {
        this.errors.push({ error: 'invalid_result', message: `test ${raw.id} result must be "pass" or "fail"` });
        continue;
      }
      this.tests.set(raw.id, { id: raw.id, lot: raw.lot, result: raw.result, revoked: raw.revoked === true });
      this.testsByLot.get(raw.lot).push(raw.id);
    }
  }

  _topoSort() {
    const indeg = new Map();
    for (const id of this.lots.keys()) indeg.set(id, this.upstreams.get(id).length);
    const queue = [...this.lots.keys()].filter((id) => indeg.get(id) === 0).sort();
    const order = [];
    while (queue.length > 0) {
      const id = queue.shift();
      order.push(id);
      for (const next of this.downstreams.get(id)) {
        indeg.set(next, indeg.get(next) - 1);
        if (indeg.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== this.lots.size) {
      const cycle = this._findCycle();
      this.errors.push({
        error: 'cycle_detected',
        message: `lineage graph contains a cycle: ${cycle.join(' -> ')}`,
        cycle,
      });
      return;
    }
    this.topo = order;
  }

  _findCycle() {
    const mark = new Map();
    const stack = [];
    const downstreams = this.downstreams;
    function dfs(id) {
      mark.set(id, 1);
      stack.push(id);
      for (const next of downstreams.get(id)) {
        const m = mark.get(next) || 0;
        if (m === 0) {
          const found = dfs(next);
          if (found) return found;
        } else if (m === 1) {
          return stack.slice(stack.indexOf(next)).concat(next);
        }
      }
      stack.pop();
      mark.set(id, 2);
      return null;
    }
    for (const id of this.lots.keys()) {
      if (!mark.get(id)) {
        const found = dfs(id);
        if (found) return found;
      }
    }
    return [];
  }

  _covers(edge, lot) {
    if (lot.start === null && lot.end === null) return true;
    const lo = edge.validFrom === null ? -Infinity : edge.validFrom;
    const hi = edge.validTo === null ? Infinity : edge.validTo;
    const ps = lot.start === null ? -Infinity : lot.start;
    const pe = lot.end === null ? Infinity : lot.end;
    return lo <= ps && hi >= pe;
  }

  _computeLot(id) {
    const lot = this.lots.get(id);
    let ownPass = false;
    const contaminatedBy = new Set();
    for (const tid of this.testsByLot.get(id)) {
      const test = this.tests.get(tid);
      if (test.revoked) continue;
      if (test.result === 'fail') contaminatedBy.add(tid);
      else ownPass = true;
    }
    const ups = this.upstreams.get(id);
    for (const { from, edge } of ups) {
      if (!this._covers(edge, lot)) continue;
      const upState = this.state.get(from);
      if (!upState || !upState.contaminated) continue;
      for (const tid of upState.contaminatedBy) contaminatedBy.add(tid);
    }
    const contaminated = contaminatedBy.size > 0;
    let status;
    if (contaminated) {
      status = 'FAIL';
    } else if (ownPass) {
      status = 'PASS';
    } else if (ups.length > 0 && ups.every((u) => {
      const s = this.state.get(u.from);
      return s && s.status === 'PASS';
    })) {
      status = 'PASS';
    } else {
      status = 'UNKNOWN';
    }
    this.state.set(id, {
      status,
      contaminated,
      contaminatedBy: [...contaminatedBy].sort(),
      ownPass,
    });
  }

  computeAll() {
    for (const id of this.topo) this._computeLot(id);
  }

  _basis(lotId) {
    const st = this.state.get(lotId);
    const inputs = this.upstreams.get(lotId)
      .map((u) => [u.from, this.state.get(u.from).status])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { lot: lotId, status: st.status, failing_tests: st.contaminatedBy, inputs };
  }

  _issueCert(lotId) {
    const basis = this._basis(lotId);
    const prev = this.certs.get(lotId);
    if (prev && canonicalize(prev.basis) === canonicalize(basis)) return null;
    const seq = prev ? prev.seq + 1 : 1;
    const hash = sha256hex(canonicalize({ ...basis, seq }));
    const record = { lot: lotId, seq, hash, status: basis.status, state: 'active', superseded_by: null, basis };
    if (prev) {
      prev.state = 'revoked';
      prev.superseded_by = hash;
    }
    this.certs.set(lotId, record);
    this.certLog.push(record);
    return record;
  }

  issueCertificates() {
    for (const id of this.topo) {
      if (this.lots.get(id).type === 'finished_good') this._issueCert(id);
    }
  }

  _downstreamClosure(start) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift();
      for (const next of this.downstreams.get(id)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  // Applies one correction incrementally. Returns null on success or an
  // error object (the correction is then skipped and state is untouched).
  applyCorrection(corr) {
    if (!corr || typeof corr !== 'object') {
      return { error: 'invalid_correction', message: 'correction must be an object' };
    }
    let affectedFrom;
    if (corr.type === 'revoke_test') {
      const test = this.tests.get(corr.test_id);
      if (!test) {
        return { error: 'unknown_test', message: `correction revokes unknown test ${String(corr.test_id)}` };
      }
      if (test.revoked) {
        return { error: 'test_already_revoked', message: `test ${test.id} is already revoked` };
      }
      test.revoked = true;
      affectedFrom = test.lot;
    } else if (corr.type === 'update_edge') {
      const key = edgeKey(corr.from, corr.to);
      const edge = this.edges.get(key);
      if (!edge) {
        return { error: 'unknown_edge', message: `correction updates unknown edge ${String(corr.from)} -> ${String(corr.to)}` };
      }
      const validFrom = parseTime(corr.valid_from);
      const validTo = parseTime(corr.valid_to);
      if (Number.isNaN(validFrom) || Number.isNaN(validTo)) {
        return { error: 'invalid_time', message: `correction for edge ${key} has an unparseable validity window` };
      }
      if (validFrom !== null && validTo !== null && validFrom > validTo) {
        return { error: 'invalid_window', message: `correction for edge ${key} sets valid_from after valid_to` };
      }
      edge.validFrom = validFrom;
      edge.validTo = validTo;
      affectedFrom = edge.to;
    } else {
      return { error: 'unknown_correction_type', message: `unknown correction type ${String(corr.type)}` };
    }

    const affected = this._downstreamClosure(affectedFrom);
    for (const id of this.topo) {
      if (!affected.has(id)) continue;
      this._computeLot(id);
      this.stats.lotsRecomputed += 1;
    }
    for (const id of this.topo) {
      if (affected.has(id) && this.lots.get(id).type === 'finished_good') {
        this._issueCert(id);
      }
    }
    this.stats.correctionsApplied += 1;
    return null;
  }

  finishedGoodIds() {
    return this.topo.filter((id) => this.lots.get(id).type === 'finished_good');
  }
}

module.exports = { Engine, parseTime, edgeKey };

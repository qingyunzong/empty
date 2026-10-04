'use strict';
// Core reconciliation engine: bipartite dependency graph between internal
// ledger rows and external bank receipts. Match candidates are maintained
// differentially per event; matching is recomputed deterministically under a
// total order (amount diff, date diff, internal id, external id); clusters are
// connected components with content-derived stable ids.

const crypto = require('node:crypto');

const RULES = {
  v1: { amountToleranceCents: 0, dateWindowDays: 0 },
  v2: { amountToleranceCents: 100, dateWindowDays: 3 },
};

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function toCents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`invalid amount: ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid amount: ${JSON.stringify(value)}`);
  return Math.round(n * 100);
}

function toDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date: ${JSON.stringify(date)}`);
  }
  const ms = Date.parse(date + 'T00:00:00Z');
  if (Number.isNaN(ms)) throw new Error(`invalid date: ${JSON.stringify(date)}`);
  return Math.floor(ms / 86400000);
}

function fmtAmount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function edgeKey(internalId, externalId) {
  return internalId + '|' + externalId;
}

// Total order for conflict resolution: amount diff, date diff, then id order.
function compareEdges(a, b) {
  if (a.amountDiff !== b.amountDiff) return a.amountDiff - b.amountDiff;
  if (a.dateDiff !== b.dateDiff) return a.dateDiff - b.dateDiff;
  if (a.i !== b.i) return a.i < b.i ? -1 : 1;
  return a.e < b.e ? -1 : a.e > b.e ? 1 : 0;
}

class Engine {
  constructor() {
    this.internals = new Map(); // id -> {id, cents, day, active}
    this.externals = new Map(); // id -> {id, cents, day, active, cancelled}
    this.edges = new Map(); // edgeKey -> {i, e, amountDiff, dateDiff}
    this.matches = new Map(); // internalId -> externalId
    this.history = []; // match/release audit trail, append-only
    this.ruleVersion = 'v1';
    this.seq = 0;
    this._pendingReason = 'upsert';
  }

  rule() {
    return RULES[this.ruleVersion];
  }

  apply(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('event must be a JSON object');
    }
    switch (event.type) {
      case 'internal': {
        const row = this._parseRow(event);
        this.internals.set(row.id, { ...row, active: true });
        this._pendingReason = 'upsert';
        this._rebuildEdgesFor(row.id, 'internal');
        break;
      }
      case 'external': {
        const row = this._parseRow(event);
        const prev = this.externals.get(row.id);
        this.externals.set(row.id, { ...row, active: true, cancelled: false });
        this._pendingReason = prev && prev.active ? 'correction' : 'upsert';
        this._rebuildEdgesFor(row.id, 'external');
        break;
      }
      case 'cancel': {
        const row = this.externals.get(event.id);
        if (!row || !row.active) throw new Error(`cannot cancel unknown/inactive external: ${event.id}`);
        row.active = false;
        row.cancelled = true;
        this._pendingReason = 'cancel';
        this._rebuildEdgesFor(row.id, 'external');
        break;
      }
      case 'rule': {
        if (!Object.hasOwn(RULES, event.version)) throw new Error(`unknown rule version: ${event.version}`);
        this.ruleVersion = event.version;
        this._pendingReason = 'rule_switch';
        this._rebuildAllEdges();
        break;
      }
      default:
        throw new Error(`unknown event type: ${JSON.stringify(event.type)}`);
    }
    this.seq += 1;
    this._rematch(this._pendingReason);
  }

  _parseRow(event) {
    if (typeof event.id !== 'string' || event.id.length === 0) throw new Error('row id must be a non-empty string');
    return { id: event.id, cents: toCents(event.amount), day: toDay(event.date) };
  }

  _isCandidate(iRow, eRow) {
    const r = this.rule();
    return (
      Math.abs(iRow.cents - eRow.cents) <= r.amountToleranceCents &&
      Math.abs(iRow.day - eRow.day) <= r.dateWindowDays
    );
  }

  _makeEdge(iRow, eRow) {
    return {
      i: iRow.id,
      e: eRow.id,
      amountDiff: Math.abs(iRow.cents - eRow.cents),
      dateDiff: Math.abs(iRow.day - eRow.day),
    };
  }

  // Differential maintenance: only edges incident to the changed row.
  _rebuildEdgesFor(id, side) {
    for (const [key, edge] of this.edges) {
      if ((side === 'internal' && edge.i === id) || (side === 'external' && edge.e === id)) {
        this.edges.delete(key);
      }
    }
    const self = side === 'internal' ? this.internals.get(id) : this.externals.get(id);
    if (!self || !self.active) return;
    const others = side === 'internal' ? this.externals : this.internals;
    for (const other of others.values()) {
      if (!other.active) continue;
      const iRow = side === 'internal' ? self : other;
      const eRow = side === 'internal' ? other : self;
      if (this._isCandidate(iRow, eRow)) this.edges.set(edgeKey(iRow.id, eRow.id), this._makeEdge(iRow, eRow));
    }
  }

  // Rule version switch: full topology cascade.
  _rebuildAllEdges() {
    this.edges.clear();
    for (const iRow of this.internals.values()) {
      if (!iRow.active) continue;
      for (const eRow of this.externals.values()) {
        if (!eRow.active) continue;
        if (this._isCandidate(iRow, eRow)) this.edges.set(edgeKey(iRow.id, eRow.id), this._makeEdge(iRow, eRow));
      }
    }
  }

  // Deterministic greedy matching under the total order; invalidation of a
  // match releases both endpoints so they can be re-claimed in the same pass.
  _rematch(reason) {
    const ordered = [...this.edges.values()].sort(compareEdges);
    const next = new Map();
    const claimedE = new Set();
    for (const edge of ordered) {
      if (next.has(edge.i) || claimedE.has(edge.e)) continue;
      next.set(edge.i, edge.e);
      claimedE.add(edge.e);
    }
    for (const [i, e] of this.matches) {
      if (next.get(i) !== e) {
        this.history.push({ seq: this.seq, event: 'released', internalId: i, externalId: e, ruleVersion: this.ruleVersion, reason });
      }
    }
    for (const [i, e] of next) {
      if (this.matches.get(i) !== e) {
        this.history.push({ seq: this.seq, event: 'matched', internalId: i, externalId: e, ruleVersion: this.ruleVersion, reason });
      }
    }
    this.matches = next;
  }

  _activeRows(map) {
    return [...map.values()].filter((r) => r.active).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // Connected components over active rows; cluster id is a content hash, so
  // recomputation from any event order yields stable ids.
  computeClusters() {
    const internals = this._activeRows(this.internals);
    const externals = this._activeRows(this.externals);
    const byId = new Map();
    const adj = new Map();
    for (const row of internals) {
      byId.set(row.id, { side: 'internal', row });
      adj.set(row.id, new Set());
    }
    for (const row of externals) {
      byId.set(row.id, { side: 'external', row });
      adj.set(row.id, new Set());
    }
    for (const edge of this.edges.values()) {
      if (adj.has(edge.i) && adj.has(edge.e)) {
        adj.get(edge.i).add(edge.e);
        adj.get(edge.e).add(edge.i);
      }
    }
    const seen = new Set();
    const clusters = [];
    for (const id of [...adj.keys()].sort()) {
      if (seen.has(id)) continue;
      const members = [];
      const queue = [id];
      seen.add(id);
      while (queue.length > 0) {
        const cur = queue.pop();
        members.push(cur);
        for (const nxt of adj.get(cur)) {
          if (!seen.has(nxt)) {
            seen.add(nxt);
            queue.push(nxt);
          }
        }
      }
      members.sort();
      clusters.push(this._buildCluster(members, byId));
    }
    return clusters;
  }

  _buildCluster(members, byId) {
    const internalIds = members.filter((m) => byId.get(m).side === 'internal');
    const externalIds = members.filter((m) => byId.get(m).side === 'external');
    const matches = [];
    for (const iId of internalIds) {
      const eId = this.matches.get(iId);
      if (eId !== undefined && byId.has(eId)) {
        const iRow = byId.get(iId).row;
        const eRow = byId.get(eId).row;
        matches.push({
          internal: iId,
          external: eId,
          amountDiffCents: eRow.cents - iRow.cents,
          dateDiffDays: eRow.day - iRow.day,
        });
      }
    }
    const matchedInternals = new Set(matches.map((m) => m.internal));
    const matchedExternals = new Set(matches.map((m) => m.external));
    const degree = new Map(members.map((m) => [m, 0]));
    for (const edge of this.edges.values()) {
      if (degree.has(edge.i)) degree.set(edge.i, degree.get(edge.i) + 1);
      if (degree.has(edge.e)) degree.set(edge.e, degree.get(edge.e) + 1);
    }
    const unresolved = [];
    for (const m of members) {
      const { side } = byId.get(m);
      const matched = side === 'internal' ? matchedInternals.has(m) : matchedExternals.has(m);
      if (matched) continue;
      unresolved.push({ side, id: m, reason: degree.get(m) > 0 ? 'conflict_lost' : 'no_candidate' });
    }
    const id = 'C-' + sha256(members.join(',')).slice(0, 16);
    const settled = unresolved.length === 0 && matches.every((m) => m.amountDiffCents === 0);
    const explanations = [];
    for (const u of unresolved) {
      explanations.push(
        u.reason === 'no_candidate'
          ? `${u.side} ${u.id} has no candidate counterpart under rule ${this.ruleVersion}`
          : `${u.side} ${u.id} lost all match conflicts under total order (amount, time window, id)`
      );
    }
    for (const h of this.history) {
      if (h.event === 'released' && (internalIds.includes(h.internalId) || externalIds.includes(h.externalId))) {
        explanations.push(`match ${h.internalId}<->${h.externalId} released at seq ${h.seq} (${h.reason})`);
      }
    }
    return {
      id,
      status: settled ? 'SETTLED' : 'UNRESOLVED',
      ruleVersion: this.ruleVersion,
      members,
      internals: internalIds,
      externals: externalIds,
      matches,
      unresolved,
      explanations,
    };
  }

  suggestionsFor(cluster) {
    const out = [];
    for (const u of cluster.unresolved) {
      if (u.side === 'internal' && u.reason === 'no_candidate') {
        out.push({ cluster: cluster.id, action: 'upload_receipt', target: u.id, detail: 'internal row awaits bank receipt upload' });
      } else if (u.side === 'internal') {
        out.push({ cluster: cluster.id, action: 'manual_review', target: u.id, detail: 'internal row lost match conflict' });
      } else {
        out.push({ cluster: cluster.id, action: 'manual_review', target: u.id, detail: `external receipt unresolved (${u.reason})` });
      }
    }
    for (const m of cluster.matches) {
      if (m.amountDiffCents !== 0) {
        out.push({
          cluster: cluster.id,
          action: 'amount_correction',
          target: m.external,
          detail: `correct receipt ${m.external} by ${fmtAmount(m.amountDiffCents)} to match internal ${m.internal}`,
          deltaCents: m.amountDiffCents,
        });
      }
    }
    return out;
  }

  // Difference clusters only (SETTLED components are omitted), deterministic
  // ordering, plus a recomputation certificate.
  snapshot() {
    const all = this.computeClusters();
    const clusters = all.filter((c) => c.status !== 'SETTLED').sort((a, b) => (a.id < b.id ? -1 : 1));
    const suggestions = clusters.flatMap((c) => this.suggestionsFor(c));
    const certificate = {
      kind: 'certificate',
      eventCount: this.seq,
      ruleVersion: this.ruleVersion,
      clusterIds: clusters.map((c) => c.id),
      digest: sha256(stableStringify({ eventCount: this.seq, ruleVersion: this.ruleVersion, clusters, suggestions })),
    };
    return { clusters, suggestions, certificate };
  }
}

module.exports = { Engine, RULES, compareEdges, toCents, toDay, fmtAmount, sha256, stableStringify };

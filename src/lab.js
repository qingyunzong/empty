import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export class LabError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'LabError';
    this.code = code;
    this.details = details;
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const isIso = (s) => typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
const ts = (s) => Date.parse(s);
const within = (t, from, to) => ts(from) <= ts(t) && ts(t) <= ts(to);
const isPosNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

export class Lab {
  constructor({ store } = {}) {
    this.artifacts = new Map(); // id -> artifact
    this.links = new Map();     // "std->target" -> { std, target }
    this.points = new Map();    // pointId -> measurement point
    this.leases = new Map();    // leaseId -> lease
    this.certs = new Map();     // certId -> cert
    this.certifiedPoints = new Set();
    this.store = store ?? null;
    this.seq = 0;
    if (this.store) for (const p of this.store.records) this.points.set(p.id, p);
  }

  addArtifact(a) {
    if (!a || typeof a.id !== 'string' || !a.id) throw new LabError('INVALID', { field: 'id' });
    if (this.artifacts.has(a.id)) throw new LabError('DUPLICATE', { id: a.id });
    if (a.kind !== 'standard' && a.kind !== 'dut') throw new LabError('INVALID', { field: 'kind' });
    if (!isPosNum(a.u)) throw new LabError('INVALID', { field: 'u' });
    for (const f of ['range', 'grade', 'envClass']) {
      if (typeof a[f] !== 'string' || !a[f]) throw new LabError('INVALID', { field: f });
    }
    if (!isIso(a.validFrom) || !isIso(a.validTo) || !(ts(a.validFrom) <= ts(a.validTo))) {
      throw new LabError('INVALID', { field: 'validity' });
    }
    const artifact = {
      id: a.id, kind: a.kind, range: a.range, grade: a.grade, envClass: a.envClass,
      u: a.u, validFrom: a.validFrom, validTo: a.validTo, root: a.root === true,
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  link(stdId, targetId) {
    const s = this.artifacts.get(stdId);
    const t = this.artifacts.get(targetId);
    if (!s || !t) throw new LabError('NOT_FOUND', { stdId, targetId });
    if (s.kind !== 'standard') throw new LabError('KIND', { id: stdId, kind: s.kind });
    if (stdId === targetId || this._reachable(targetId, stdId)) {
      throw new LabError('CYCLE', { stdId, targetId });
    }
    const key = stdId + '->' + targetId;
    if (this.links.has(key)) throw new LabError('DUPLICATE', { link: key });
    this.links.set(key, { std: stdId, target: targetId });
    return { std: stdId, target: targetId };
  }

  unlink(stdId, targetId) {
    const key = stdId + '->' + targetId;
    if (!this.links.has(key)) throw new LabError('NOT_FOUND', { link: key });
    const downstream = this._closure(targetId);
    for (const [pid, p] of this.points) {
      if (downstream.has(p.dut) && !this.certifiedPoints.has(pid)) {
        throw new LabError('PENDING_MEASUREMENTS', { point: pid, link: key });
      }
    }
    this.links.delete(key);
    return { unlinked: key };
  }

  measure(p) {
    if (!p || typeof p.id !== 'string' || !p.id) throw new LabError('INVALID', { field: 'id' });
    if (this.points.has(p.id)) throw new LabError('DUPLICATE', { id: p.id });
    const dut = this.artifacts.get(p.dut);
    if (!dut || dut.kind !== 'dut') throw new LabError('INVALID', { field: 'dut' });
    if (!isIso(p.time)) throw new LabError('INVALID', { field: 'time' });
    for (const f of ['range', 'envClass']) {
      if (typeof p[f] !== 'string' || !p[f]) throw new LabError('INVALID', { field: f });
    }
    if (p.budget !== undefined && !isPosNum(p.budget)) throw new LabError('INVALID', { field: 'budget' });
    if (p.envWindow !== undefined && p.envWindow !== null) {
      const w = p.envWindow;
      if (!w || !isIso(w.start) || !isIso(w.end) || !(ts(w.start) <= ts(w.end)) || typeof w.class !== 'string') {
        throw new LabError('INVALID', { field: 'envWindow' });
      }
    }
    const point = {
      id: p.id, dut: p.dut, time: p.time, range: p.range, envClass: p.envClass,
      budget: p.budget ?? null,
      envWindow: p.envWindow ? { ...p.envWindow } : null,
    };
    if (this.store) this.store.append(point); // durable before visible
    this.points.set(point.id, point);
    return point;
  }

  reserve(stdId, pointId) {
    const s = this.artifacts.get(stdId);
    if (!s || s.kind !== 'standard') throw new LabError('NOT_FOUND', { stdId });
    if (!this.points.has(pointId)) throw new LabError('NOT_FOUND', { pointId });
    if (this._leasedElsewhere(stdId, pointId)) {
      throw new LabError('LEASE_STATE', { stdId, pointId, reason: 'already leased' });
    }
    const lease = { id: 'L' + (++this.seq), std: stdId, point: pointId, active: true };
    this.leases.set(lease.id, lease);
    return lease;
  }

  release(leaseId) {
    const lease = this.leases.get(leaseId);
    if (!lease || !lease.active) throw new LabError('LEASE_STATE', { leaseId });
    lease.active = false;
    return { released: leaseId };
  }

  certify(pointId, opts = {}) {
    const point = this.points.get(pointId);
    if (!point) {
      return { status: 'INSUFFICIENT_EVIDENCE', point: pointId, missing: ['MEASUREMENT'] };
    }
    const missing = [];
    const dut = this.artifacts.get(point.dut);
    if (!dut) missing.push('DUT');
    if (!point.envWindow) missing.push('ENV_WINDOW');
    if (missing.length) return { status: 'INSUFFICIENT_EVIDENCE', point: pointId, missing };

    const core = [];
    const w = point.envWindow;
    if (!within(point.time, w.start, w.end)) {
      core.push({ constraint: 'ENV_WINDOW_COVER', time: point.time, window: { start: w.start, end: w.end } });
    }
    if (w.class !== point.envClass) {
      core.push({ constraint: 'ENV_CLASS', expect: point.envClass, actual: w.class });
    }

    const { chains, core: chainCore } = this._chainsFor(dut.id, point, new Set([dut.id]));
    if (chains.length === 0) core.push(...chainCore);
    if (core.length > 0) return { status: 'REFUTE', point: pointId, core };

    const scored = chains.map((c) => ({ chain: c, U: this._combined(c) }));
    scored.sort((a, b) => a.U - b.U);
    const best = scored[0];
    const budget = opts.budget ?? point.budget ?? null;
    if (budget !== null && best.U > budget) {
      return {
        status: 'PENDING', point: pointId, reason: 'BUDGET',
        chain: best.chain, combinedUncertainty: best.U, budget,
      };
    }

    const chainDetail = best.chain.map((id) => {
      const a = this.artifacts.get(id);
      return { id, kind: a.kind, u: a.u, range: a.range, validFrom: a.validFrom, validTo: a.validTo };
    });
    const payload = {
      point: pointId, dut: dut.id, time: point.time, range: point.range,
      envClass: point.envClass, envWindow: w, chain: chainDetail,
      combinedUncertainty: best.U, budget,
    };
    const cert = { id: 'C' + (++this.seq), status: 'CERT', ...payload, hash: sha256(canonical(payload)) };
    this.certs.set(cert.id, cert);
    this.certifiedPoints.add(pointId);
    return cert;
  }

  audit(cert) {
    if (!cert || typeof cert !== 'object' || cert.status !== 'CERT') return { status: 'INVALID' };
    const { id, hash, status, ...payload } = cert;
    if (typeof hash !== 'string' || sha256(canonical(payload)) !== hash) {
      return { status: 'TAMPERED', field: 'hash' };
    }
    const standards = payload.chain.filter((m) => m.kind === 'standard');
    const U = 2 * Math.sqrt(standards.reduce((acc, m) => acc + m.u * m.u, 0));
    if (U !== payload.combinedUncertainty) return { status: 'TAMPERED', field: 'combinedUncertainty' };

    const failures = [];
    for (let i = 0; i + 1 < payload.chain.length; i++) {
      if (!(payload.chain[i].u < payload.chain[i + 1].u)) {
        failures.push({ constraint: 'UNCERTAINTY_DOMINANCE', artifact: payload.chain[i].id });
      }
    }
    for (const m of standards) {
      if (!within(payload.time, m.validFrom, m.validTo)) {
        failures.push({ constraint: 'VALIDITY', artifact: m.id });
      }
      if (m.range !== payload.range) {
        failures.push({ constraint: 'RANGE', artifact: m.id });
      }
    }
    const w = payload.envWindow;
    if (!w || !within(payload.time, w.start, w.end)) {
      failures.push({ constraint: 'ENV_WINDOW_COVER' });
    } else if (w.class !== payload.envClass) {
      failures.push({ constraint: 'ENV_CLASS' });
    }
    if (payload.budget !== null && payload.combinedUncertainty > payload.budget) {
      failures.push({ constraint: 'BUDGET' });
    }
    if (failures.length > 0) return { status: 'NOT_REPRODUCIBLE', failures };
    return { status: 'VALID', cert: id };
  }

  // ---- internals ----

  _combined(chainIds) {
    let sum = 0;
    for (const id of chainIds) {
      const a = this.artifacts.get(id);
      if (a.kind === 'standard') sum += a.u * a.u;
    }
    return 2 * Math.sqrt(sum);
  }

  _leasedElsewhere(stdId, pointId) {
    for (const l of this.leases.values()) {
      if (l.active && l.std === stdId && l.point !== pointId) return true;
    }
    return false;
  }

  _reachable(from, to) {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === to) return true;
      for (const l of this.links.values()) {
        if (l.std === cur && !seen.has(l.target)) {
          seen.add(l.target);
          stack.push(l.target);
        }
      }
    }
    return false;
  }

  _closure(from) {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop();
      for (const l of this.links.values()) {
        if (l.std === cur && !seen.has(l.target)) {
          seen.add(l.target);
          stack.push(l.target);
        }
      }
    }
    return seen;
  }

  // Backtracking chain search. Returns all valid root->...->art chains and, when
  // none exist, a minimal-cardinality failure core along the best-effort path.
  _chainsFor(artId, point, visiting) {
    const art = this.artifacts.get(artId);
    const incoming = [...this.links.values()].filter((l) => l.target === artId);
    const chains = [];
    // A designated root standard is traceable on its own: the chain may stop here.
    if (art.kind === 'standard' && art.root) chains.push([artId]);
    if (incoming.length === 0) {
      if (chains.length > 0) return { chains, core: [] };
      return { chains: [], core: [{ constraint: 'TRACEABILITY_ROOT', artifact: artId }] };
    }
    let core = null;
    for (const l of incoming) {
      const s = this.artifacts.get(l.std);
      const local = [];
      if (visiting.has(l.std)) local.push({ constraint: 'CYCLE', artifact: l.std });
      if (s.range !== point.range) {
        local.push({ constraint: 'RANGE', artifact: l.std, expect: point.range, actual: s.range });
      }
      if (!(s.u < art.u)) {
        local.push({ constraint: 'UNCERTAINTY_DOMINANCE', artifact: l.std, stdU: s.u, targetU: art.u });
      }
      if (!within(point.time, s.validFrom, s.validTo)) {
        local.push({ constraint: 'VALIDITY', artifact: l.std, validFrom: s.validFrom, validTo: s.validTo, time: point.time });
      }
      if (this._leasedElsewhere(l.std, point.id)) {
        local.push({ constraint: 'LEASE', artifact: l.std, point: point.id });
      }
      let branch;
      if (local.length > 0) {
        branch = local;
      } else {
        const sub = this._chainsFor(l.std, point, new Set(visiting).add(l.std));
        if (sub.chains.length > 0) {
          for (const c of sub.chains) chains.push([...c, artId]);
          continue;
        }
        branch = sub.core;
      }
      if (core === null || branch.length < core.length) core = branch;
    }
    return { chains, core: core ?? [] };
  }
}

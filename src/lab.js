'use strict';

const { LabError } = require('./errors.js');
const { evaluate } = require('./certify.js');
const { auditCert } = require('./audit.js');

const KINDS = ['standard', 'uut', 'point'];

function freshState() {
  return { artifacts: {}, links: [], leases: {}, certs: {}, measurements: [] };
}

// BFS over traceability links: can `fromId` reach `targetId`?
function reaches(state, fromId, targetId) {
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === targetId) return true;
    for (const l of state.links) {
      if (l.from === cur && !seen.has(l.to)) {
        seen.add(l.to);
        queue.push(l.to);
      }
    }
  }
  return false;
}

class Lab {
  constructor({ state, journal } = {}) {
    this.state = state || freshState();
    this.journal = journal || null;
  }

  addArtifact(spec) {
    const { id, kind } = spec || {};
    if (!id || typeof id !== 'string') throw new LabError('INVALID', 'artifact id is required');
    if (this.state.artifacts[id]) throw new LabError('DUPLICATE', `artifact already exists: ${id}`);
    if (!KINDS.includes(kind)) throw new LabError('INVALID', `unknown artifact kind: ${kind}`);
    const a = { ...spec };
    if (kind === 'standard') {
      if (typeof a.uncertainty !== 'number' || !(a.uncertainty > 0)) {
        throw new LabError('INVALID', 'standard requires a positive numeric uncertainty');
      }
      if (!a.root && (!a.validFrom || !a.validTo)) {
        throw new LabError('INVALID', 'non-root standard requires validFrom/validTo');
      }
      if (!a.rangeClass || !a.envClass) {
        throw new LabError('INVALID', 'standard requires rangeClass and envClass');
      }
    }
    if (kind === 'uut' && (!a.rangeClass || !a.envClass)) {
      throw new LabError('INVALID', 'uut requires rangeClass and envClass');
    }
    if (kind === 'point') {
      const uut = a.uutId && this.state.artifacts[a.uutId];
      if (!uut || uut.kind !== 'uut') throw new LabError('INVALID', 'point requires an existing uutId');
      if (typeof a.budget !== 'number' || !(a.budget > 0)) {
        throw new LabError('INVALID', 'point requires a positive numeric budget');
      }
      if (!a.rangeClass || !a.envClass) throw new LabError('INVALID', 'point requires rangeClass and envClass');
      if (a.margin !== undefined && (typeof a.margin !== 'number' || a.margin < 0 || a.margin >= 0.5)) {
        throw new LabError('INVALID', 'point margin must be a number in [0, 0.5)');
      }
      if (a.window !== undefined && a.window !== null) {
        const w = a.window;
        const ok =
          w && ['tempMin', 'tempMax', 'humMin', 'humMax'].every((k) => typeof w[k] === 'number') &&
          w.tempMin <= w.tempMax && w.humMin <= w.humMax;
        if (!ok) throw new LabError('INVALID', 'window must be {tempMin,tempMax,humMin,humMax} with min<=max');
      }
    }
    for (const key of ['validFrom', 'validTo']) {
      if (a[key] !== undefined && Number.isNaN(Date.parse(a[key]))) {
        throw new LabError('INVALID', `${key} is not a parseable date: ${a[key]}`);
      }
    }
    this.state.artifacts[id] = a;
    return a;
  }

  link(from, to) {
    const a = this.state.artifacts[from];
    const b = this.state.artifacts[to];
    if (!a) throw new LabError('NOT_FOUND', `unknown artifact: ${from}`);
    if (!b) throw new LabError('NOT_FOUND', `unknown artifact: ${to}`);
    if (from === to) throw new LabError('INVALID', 'self links are not allowed');
    if (a.kind === 'point') throw new LabError('INVALID_KIND', 'measurement points cannot trace to standards');
    if (b.kind !== 'standard') throw new LabError('INVALID_KIND', 'link target must be a standard');
    if (this.state.links.some((l) => l.from === from && l.to === to)) {
      throw new LabError('DUPLICATE', `link already exists: ${from} -> ${to}`);
    }
    const l = { from, to };
    this.state.links.push(l);
    return l;
  }

  pendingMeasurements() {
    const covered = new Set(Object.values(this.state.certs).map((c) => c.inputs.measurement.id));
    return this.state.measurements.filter((m) => !covered.has(m.id));
  }

  // unlink is only allowed when no uncertified (pending) measurement depends
  // on a traceability path through `from`.
  unlink(from, to) {
    const idx = this.state.links.findIndex((l) => l.from === from && l.to === to);
    if (idx < 0) throw new LabError('NOT_FOUND', `no such link: ${from} -> ${to}`);
    const affectedUuts = new Set();
    for (const a of Object.values(this.state.artifacts)) {
      if (a.kind !== 'uut') continue;
      if (a.id === from || reaches(this.state, a.id, from)) affectedUuts.add(a.id);
    }
    const pending = this.pendingMeasurements().filter((m) => {
      const p = this.state.artifacts[m.pointId];
      return p && affectedUuts.has(p.uutId);
    });
    if (pending.length > 0) {
      throw new LabError('UNLINK_BLOCKED', 'pending measurements depend on this chain', {
        pending: pending.map((m) => m.id),
      });
    }
    const [removed] = this.state.links.splice(idx, 1);
    return removed;
  }

  // The only operation with durable persistence: the record is appended to the
  // journal (append + fsync) before it becomes visible in memory.
  measure(rec) {
    const point = rec && this.state.artifacts[rec.pointId];
    if (!point || point.kind !== 'point') {
      throw new LabError('NO_SUCH_POINT', `no such measurement point: ${rec && rec.pointId}`);
    }
    if (typeof rec.value !== 'number' || Number.isNaN(rec.value)) {
      throw new LabError('INVALID', 'measurement requires a numeric value');
    }
    const record = {
      id: `M-${this.state.measurements.length + 1}`,
      pointId: rec.pointId,
      value: rec.value,
      temp: rec.temp === undefined ? null : rec.temp,
      humidity: rec.humidity === undefined ? null : rec.humidity,
      uMeas: typeof rec.uMeas === 'number' ? rec.uMeas : 0,
      at: rec.at || new Date().toISOString(),
    };
    if (this.journal) this.journal.append({ type: 'measure', record });
    this.state.measurements.push(record);
    return record;
  }

  reserve(standardId, holder) {
    const a = this.state.artifacts[standardId];
    if (!a) throw new LabError('NOT_FOUND', `unknown artifact: ${standardId}`);
    if (a.kind !== 'standard') throw new LabError('INVALID_KIND', 'only standards can be reserved');
    if (!holder) throw new LabError('INVALID', 'reserve requires a holder');
    if (this.state.leases[standardId]) {
      throw new LabError('LEASE_STATE', `standard already reserved: ${standardId}`, {
        holder: this.state.leases[standardId].holder,
      });
    }
    const lease = { standard: standardId, holder, since: new Date().toISOString() };
    this.state.leases[standardId] = lease;
    return lease;
  }

  release(standardId, holder) {
    const lease = this.state.leases[standardId];
    if (!lease) throw new LabError('LEASE_STATE', `standard is not reserved: ${standardId}`);
    if (lease.holder !== holder) {
      throw new LabError('LEASE_STATE', `standard ${standardId} is held by ${lease.holder}, not ${holder}`);
    }
    delete this.state.leases[standardId];
    return { released: standardId, holder };
  }

  certify(pointId, at) {
    const r = evaluate(this, pointId, at || new Date().toISOString());
    if (r.status === 'CERT') this.state.certs[r.cert.id] = r.cert;
    return r;
  }

  audit(certOrId) {
    return auditCert(this, certOrId);
  }
}

module.exports = { Lab, freshState, reaches };

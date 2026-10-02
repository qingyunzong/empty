'use strict';

const { contentChecksum } = require('./checksum');
const { appendCert, verifyChain } = require('./certs');
const { selectPlacement, rankRequesters, allocateBandwidth } = require('./scheduler');

// Error codes that map to CLI exit code 11.
const EXIT_ERROR_CODES = new Set(['checksum-error', 'disk-full', 'cyclic-dependency']);

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const cmpId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

class ArchiveSystem {
  constructor(config = {}) {
    this.config = {
      bandwidth: Number.isInteger(config.bandwidth) && config.bandwidth > 0 ? config.bandwidth : 1024,
      staging: Number.isInteger(config.staging) && config.staging > 0 ? config.staging : 4096,
      maxWait: Number.isInteger(config.maxWait) && config.maxWait >= 0 ? config.maxWait : 10,
      quotas: { ...(config.quotas || {}) },
    };
    this.objects = new Map(); // id -> object record
    this.stats = new Map(); // requester -> { completedBytes }
    this.stagingUsed = 0;
    this.certs = []; // hash-chained certificate chain
    this.time = 0;
    this.generation = 0;
    this.txLog = []; // [{ gen, snapshot }] for generation-based undo
    this.failAt = null; // injected fault point: 'staging' | 'index' | 'cert'
  }

  // ---- persistence -------------------------------------------------------

  _snapshot() {
    return structuredClone({
      config: this.config,
      objects: [...this.objects.values()],
      stats: [...this.stats.entries()],
      stagingUsed: this.stagingUsed,
      certs: this.certs,
      time: this.time,
      generation: this.generation,
    });
  }

  _restore(snapshot) {
    this.config = structuredClone(snapshot.config);
    this.objects = new Map(snapshot.objects.map((o) => [o.id, structuredClone(o)]));
    this.stats = new Map(snapshot.stats.map(([k, v]) => [k, { ...v }]));
    this.stagingUsed = snapshot.stagingUsed;
    this.certs = snapshot.certs.map((c) => ({ ...c }));
    this.time = snapshot.time;
    this.generation = snapshot.generation;
  }

  toJSON() {
    return { ...this._snapshot(), txLog: this.txLog };
  }

  static fromJSON(data) {
    const sys = new ArchiveSystem(data.config);
    sys._restore(data);
    sys.txLog = data.txLog || [];
    return sys;
  }

  // ---- transactions ------------------------------------------------------

  _tx(fn) {
    const snapshot = this._snapshot();
    const gen = this.generation + 1;
    try {
      const result = fn(gen);
      this.generation = gen;
      this.txLog.push({ gen, snapshot });
      return result;
    } catch (err) {
      this._restore(snapshot);
      if (err instanceof ArchiveError && err.code === 'fault') {
        return {
          aborted: true,
          fault: err.fault,
          ticks: [],
          failures: [{ reason: 'fault', phase: err.fault }],
          placement: this._placement(),
          certificates: this.certs.slice(),
        };
      }
      throw err;
    }
  }

  undo(steps = 1) {
    if (!Number.isInteger(steps) || steps < 1 || this.txLog.length < steps) {
      throw new ArchiveError('usage', 'nothing to undo');
    }
    let snapshot = null;
    for (let i = 0; i < steps; i++) snapshot = this.txLog.pop().snapshot;
    this._restore(snapshot);
    return { generation: this.generation };
  }

  _phase(name) {
    if (this.failAt === name) {
      const err = new ArchiveError('fault', `injected fault at write-${name}`);
      err.fault = name;
      throw err;
    }
  }

  // ---- objects -----------------------------------------------------------

  _get(id) {
    const obj = this.objects.get(id);
    if (!obj) throw new ArchiveError('usage', `unknown object ${id}`);
    return obj;
  }

  _trueChecksum(obj) {
    const parentSum = obj.parent ? this._trueChecksum(this._get(obj.parent)) : null;
    return contentChecksum(obj.id, parentSum);
  }

  request({ id, size, checksum = null, retention = 1, requester = 'default', parent = null, locked = false }) {
    if (typeof id !== 'string' || id.length === 0) throw new ArchiveError('usage', 'object id required');
    if (this.objects.has(id)) throw new ArchiveError('usage', `duplicate object ${id}`);
    if (!Number.isInteger(size) || size <= 0) throw new ArchiveError('usage', `bad size for ${id}`);
    if (!Number.isInteger(retention) || retention < 0) throw new ArchiveError('usage', `bad retention for ${id}`);
    for (let p = parent; p !== null; ) {
      if (p === id) throw new ArchiveError('cyclic-dependency', `cyclic dependency involving ${id}`);
      const po = this.objects.get(p);
      p = po ? po.parent : null;
    }
    let sum = checksum;
    if (sum === null && parent === null) sum = contentChecksum(id, null);
    if (sum === null) {
      const po = this.objects.get(parent);
      if (po && po.checksum !== null) sum = contentChecksum(id, po.checksum);
    }
    const obj = {
      id, size, checksum: sum, retention, requester, parent,
      locked: Boolean(locked),
      status: 'pending', // pending|restoring|verified|evicted|failed
      progress: 0,
      allocated: false,
      requestedAt: this.time,
      failReason: null,
      verifiedGen: null,
    };
    this.objects.set(id, obj);
    if (!(requester in this.config.quotas)) this.config.quotas[requester] = 1;
    if (!this.stats.has(requester)) this.stats.set(requester, { completedBytes: 0 });
    this._fillChecksums();
    return obj;
  }

  // Fill deferred checksums for objects whose parent volume arrived later.
  _fillChecksums() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const o of this.objects.values()) {
        if (o.checksum === null && o.parent !== null) {
          const po = this.objects.get(o.parent);
          if (po && po.checksum !== null) {
            o.checksum = contentChecksum(o.id, po.checksum);
            changed = true;
          }
        }
      }
    }
  }

  _depsSatisfied(obj) {
    if (obj.parent === null) return true;
    const po = this.objects.get(obj.parent);
    // A pending/unresolved parent volume only blocks scheduling; the child is
    // never judged unrecoverable because of it.
    return Boolean(po) && (po.status === 'verified' || po.status === 'staged');
  }

  _allocate(obj) {
    obj.allocated = true;
    this.stagingUsed += obj.size;
  }

  _free(obj) {
    if (obj.allocated) {
      obj.allocated = false;
      this.stagingUsed -= obj.size;
    }
  }

  _evict(obj, reason, rec, gen) {
    this._free(obj);
    obj.status = 'evicted';
    obj.progress = 0;
    const cert = appendCert(this.certs, { gen, action: 'evict', object: obj.id, reason, checksum: obj.checksum });
    rec.evicted.push({ object: obj.id, reason, proof: cert.hash });
  }

  _priorityOrder(list) {
    if (list.length === 0) return list;
    const byReq = new Map();
    for (const o of list) {
      if (!byReq.has(o.requester)) byReq.set(o.requester, []);
      byReq.get(o.requester).push(o);
    }
    const reqs = [...byReq.entries()].map(([name, objs]) => {
      const s = this.stats.get(name) || { completedBytes: 0 };
      const longestWait = Math.max(...objs.map((o) => this.time - o.requestedAt));
      return {
        name,
        weight: this.config.quotas[name] ?? 1,
        completedBytes: s.completedBytes,
        waitExceeded: longestWait >= this.config.maxWait,
        longestWait,
      };
    });
    const ranked = rankRequesters(reqs);
    const rankOf = new Map(ranked.map((n, i) => [n, i]));
    return [...list].sort(
      (a, b) =>
        rankOf.get(a.requester) - rankOf.get(b.requester) ||
        b.retention - a.retention ||
        a.requestedAt - b.requestedAt ||
        cmpId(a, b),
    );
  }

  _placement() {
    return [...this.objects.values()]
      .filter((o) => o.allocated)
      .sort(cmpId)
      .map((o) => ({ id: o.id, requester: o.requester, retention: o.retention, size: o.size, status: o.status }));
  }

  // ---- restore scheduling -------------------------------------------------

  restore({ ticks = 1, failAt = null } = {}) {
    if (!Number.isInteger(ticks) || ticks < 1) throw new ArchiveError('usage', 'ticks must be a positive integer');
    if (failAt !== null && !['staging', 'index', 'cert'].includes(failAt)) {
      throw new ArchiveError('usage', `bad fault point ${failAt}`);
    }
    return this._tx(() => {
      this.failAt = failAt;
      const out = { ticks: [], failures: [] };
      try {
        for (let t = 0; t < ticks; t++) out.ticks.push(this._tick(out));
      } finally {
        this.failAt = null;
      }
      return {
        aborted: false,
        placement: this._placement(),
        timeSlices: out.ticks,
        failures: out.failures,
        certificates: this.certs.slice(),
      };
    });
  }

  _tick(out) {
    this.time++;
    const gen = this.generation + 1;
    const rec = { tick: this.time, admitted: [], allocations: [], completed: [], evicted: [] };

    const eligible = [...this.objects.values()].filter(
      (o) => (o.status === 'pending' || o.status === 'restoring' || o.status === 'evicted') && this._depsSatisfied(o),
    );
    const unallocated = eligible.filter((o) => !o.allocated);
    const ordered = this._priorityOrder(unallocated);

    // Placement: exact max-retention-weight subset within free staging.
    const free = this.config.staging - this.stagingUsed;
    const admitted = selectPlacement(
      ordered.map((o) => ({ id: o.id, size: o.size, retention: o.retention })),
      Math.max(0, free),
    );
    for (const id of admitted.ids) {
      this._allocate(this.objects.get(id));
      rec.admitted.push(id);
    }

    // Preemption: higher retention objects evict lower retention unlocked ones.
    for (const obj of ordered) {
      if (obj.allocated || obj.status === 'failed') continue;
      this._tryPreemptAllocate(obj, rec, out, gen);
    }

    // Bandwidth time slice among active restores, fairness-ordered.
    const active = this._priorityOrder(eligible.filter((o) => o.allocated && o.progress < o.size));
    const allocs = allocateBandwidth(
      active.map((o) => ({ id: o.id, remaining: o.size - o.progress })),
      this.config.bandwidth,
    );
    for (const o of active) {
      const bytes = allocs.get(o.id) || 0;
      if (bytes > 0) {
        o.progress += bytes;
        o.status = 'restoring';
        rec.allocations.push({ object: o.id, requester: o.requester, bytes });
      }
    }

    for (const o of active) {
      if (o.allocated && o.progress >= o.size && o.status === 'restoring') this._complete(o, rec, out, gen);
    }
    return rec;
  }

  _tryPreemptAllocate(obj, rec, out, gen) {
    const need = obj.size;
    const capacity = this.config.staging;
    if (capacity - this.stagingUsed >= need) {
      this._allocate(obj);
      rec.admitted.push(obj.id);
      return true;
    }
    const evictable = [...this.objects.values()]
      .filter((o) => o.allocated && o.status === 'verified' && !o.locked && o.retention < obj.retention)
      .sort((a, b) => a.retention - b.retention || b.size - a.size || cmpId(a, b));
    for (const victim of evictable) {
      if (capacity - this.stagingUsed >= need) break;
      this._evict(victim, `preempted-by:${obj.id}`, rec, gen);
    }
    if (capacity - this.stagingUsed >= need) {
      this._allocate(obj);
      rec.admitted.push(obj.id);
      return true;
    }
    if (obj.size > capacity) {
      obj.status = 'failed';
      obj.failReason = 'disk-full';
      out.failures.push({ object: obj.id, reason: 'disk-full' });
    }
    // Otherwise it keeps waiting for staging to free up; not an error.
    return false;
  }

  _complete(obj, rec, out, gen) {
    this._phase('staging'); // fault point: write staging
    obj.status = 'staged';
    this._phase('index'); // fault point: write index
    if (obj.checksum !== this._trueChecksum(obj)) {
      obj.status = 'failed';
      obj.failReason = 'checksum-error';
      this._free(obj);
      rec.completed.push({ object: obj.id, ok: false, reason: 'checksum-error' });
      out.failures.push({ object: obj.id, reason: 'checksum-error' });
      return;
    }
    obj.status = 'verified';
    obj.verifiedGen = gen;
    this.stats.get(obj.requester).completedBytes += obj.size;
    this._phase('cert'); // fault point: write certificate
    appendCert(this.certs, {
      gen,
      action: 'restore',
      object: obj.id,
      checksum: obj.checksum,
      requester: obj.requester,
    });
    rec.completed.push({ object: obj.id, ok: true });
  }

  // ---- correct / evict / verify -------------------------------------------

  correct(id) {
    const obj = this._get(id);
    return this._tx((gen) => {
      obj.checksum = this._trueChecksum(obj);
      if (obj.status === 'failed' && obj.failReason === 'checksum-error') {
        obj.status = 'pending';
        obj.failReason = null;
        obj.progress = 0;
      }
      // Re-verify the object and its dependent child volumes only.
      const affected = [obj, ...this._descendants(id)];
      const reverified = [];
      for (const o of affected) {
        if (!o.allocated) continue;
        const ok = o.checksum === this._trueChecksum(o);
        o.status = ok ? 'verified' : 'failed';
        o.failReason = ok ? null : 'checksum-error';
        if (ok) o.verifiedGen = gen;
        else this._free(o);
        reverified.push({ id: o.id, ok });
      }
      appendCert(this.certs, { gen, action: 'correct', object: id, checksum: obj.checksum });
      return { corrected: id, checksum: obj.checksum, reverified };
    });
  }

  _descendants(id) {
    const out = [];
    for (const o of this.objects.values()) {
      for (let p = o.parent; p !== null; ) {
        if (p === id) {
          out.push(o);
          break;
        }
        const po = this.objects.get(p);
        p = po ? po.parent : null;
      }
    }
    return out.sort(cmpId);
  }

  evict(id, reason = 'manual') {
    const obj = this._get(id);
    return this._tx((gen) => {
      if (!obj.allocated) throw new ArchiveError('usage', `object ${id} is not staged`);
      const rec = { evicted: [] };
      this._evict(obj, reason, rec, gen);
      return { evicted: id, proof: rec.evicted[0].proof };
    });
  }

  verify() {
    const chain = verifyChain(this.certs);
    const objects = {};
    let ok = chain.ok && this.stagingUsed <= this.config.staging;
    for (const o of [...this.objects.values()].sort(cmpId)) {
      let checksumOk = null;
      if (o.status === 'verified' || o.status === 'staged') {
        checksumOk = o.checksum === this._trueChecksum(o);
        if (!checksumOk) ok = false;
      }
      objects[o.id] = { status: o.status, checksumOk, verifiedGen: o.verifiedGen, failReason: o.failReason };
    }
    return {
      ok,
      generation: this.generation,
      time: this.time,
      stagingUsed: this.stagingUsed,
      stagingCapacity: this.config.staging,
      chainOk: chain.ok,
      objects,
    };
  }
}

module.exports = { ArchiveSystem, ArchiveError, EXIT_ERROR_CODES };

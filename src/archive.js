'use strict';

const crypto = require('node:crypto');

const EXIT_DATA_ERR = 11;

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
class ChecksumError extends ArchiveError {
  constructor(message) { super('CHECKSUM', message); }
}
class DiskFullError extends ArchiveError {
  constructor(message) { super('DISK_FULL', message); }
}
class CycleError extends ArchiveError {
  constructor(message) { super('CYCLE', message); }
}
class FaultError extends ArchiveError {
  constructor(point) {
    super('FAULT', `injected fault at write-${point}`);
    this.point = point;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function knapsack(items, capacity) {
  const dp = new Array(capacity + 1).fill(0);
  const picks = Array.from({ length: capacity + 1 }, () => []);
  const sorted = [...items].sort(byId);
  for (let i = 0; i < sorted.length; i += 1) {
    const { size, retention } = sorted[i];
    for (let c = capacity; c >= size; c -= 1) {
      const candidate = dp[c - size] + retention;
      if (candidate > dp[c]) {
        dp[c] = candidate;
        picks[c] = [...picks[c - size], i];
      }
    }
  }
  let best = 0;
  for (let c = 1; c <= capacity; c += 1) {
    if (dp[c] > dp[best]) best = c;
  }
  return { value: dp[best], selected: picks[best].map((i) => sorted[i]) };
}

class Archive {
  constructor(options = {}) {
    const {
      stagingCapacity = 1024,
      bandwidthPerTick = 16,
      waitCap = 8,
    } = options;
    this.state = {
      stagingCapacity,
      bandwidthPerTick,
      waitCap,
      tick: 0,
      generation: 0,
      certSeq: 0,
      objects: {},
      quotas: {},
      certificates: [],
      evictions: [],
    };
    this.history = [];
  }

  static fromJSON(json) {
    const archive = new Archive();
    archive.state = json.state;
    archive.history = json.history;
    return archive;
  }

  toJSON() {
    return { state: this.state, history: this.history };
  }

  _snapshot() {
    return JSON.stringify(this.state);
  }

  _restore(snapshot) {
    this.state = JSON.parse(snapshot);
  }

  _begin() {
    this.history.push(this._snapshot());
    this.state.generation += 1;
  }

  _rollback() {
    const snapshot = this.history.pop();
    this._restore(snapshot);
  }

  _transact(fn) {
    this._begin();
    try {
      return fn();
    } catch (err) {
      this._rollback();
      throw err;
    }
  }

  _fault(point, failAt) {
    if (failAt === point) throw new FaultError(point);
  }

  _require(id) {
    const obj = this.state.objects[id];
    if (!obj) throw new ArchiveError('NOT_FOUND', `unknown object: ${id}`);
    return obj;
  }

  request(spec) {
    const {
      id, size, retention, requester,
      checksum, data, parent = null, locked = false, quota = 1,
    } = spec || {};
    if (!id || typeof id !== 'string') throw new ArchiveError('BAD_REQUEST', 'request requires string id');
    if (!Number.isInteger(size) || size <= 0) throw new ArchiveError('BAD_REQUEST', `bad size for ${id}`);
    if (!Number.isInteger(retention) || retention < 0) throw new ArchiveError('BAD_REQUEST', `bad retention for ${id}`);
    if (!requester) throw new ArchiveError('BAD_REQUEST', `missing requester for ${id}`);
    if (!Number.isInteger(quota) || quota <= 0) throw new ArchiveError('BAD_REQUEST', `bad quota for ${requester}`);
    if (this.state.objects[id]) throw new ArchiveError('DUPLICATE', `object already registered: ${id}`);
    if (parent !== null && !this.state.objects[parent]) {
      throw new ArchiveError('BAD_REQUEST', `unknown parent volume: ${parent}`);
    }
    const payload = data === undefined ? id : String(data);
    return this._transact(() => {
      this.state.objects[id] = {
        id,
        size,
        checksum: checksum || sha256(payload),
        data: payload,
        retention,
        requester,
        parent,
        locked: Boolean(locked),
        status: 'pending',
        stagedBytes: 0,
        waitTicks: 0,
        verified: false,
        verifyCount: 0,
        lastOk: null,
        failReason: null,
        offset: null,
      };
      if (!this.state.quotas[requester]) {
        this.state.quotas[requester] = { weight: quota, completedBytes: 0 };
      }
      return { id, status: 'pending', generation: this.state.generation };
    });
  }

  _checkCycles() {
    const objects = this.state.objects;
    for (const id of Object.keys(objects)) {
      const seen = new Set([id]);
      let cur = objects[id].parent;
      while (cur !== null) {
        if (seen.has(cur)) throw new CycleError(`cyclic dependency involving ${id}`);
        seen.add(cur);
        cur = objects[cur] ? objects[cur].parent : null;
      }
    }
  }

  _withDescendants(id) {
    const objects = this.state.objects;
    const result = [objects[id]];
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift();
      const children = Object.values(objects).filter((o) => o.parent === cur).sort(byId);
      for (const child of children) {
        result.push(child);
        queue.push(child.id);
      }
    }
    return result;
  }

  _cert(action, objectId, detail = {}) {
    const state = this.state;
    const prev = state.certificates.length > 0
      ? state.certificates[state.certificates.length - 1].hash
      : 'genesis';
    const body = {
      seq: state.certSeq,
      generation: state.generation,
      action,
      objectId,
      detail,
      prev,
    };
    state.certSeq += 1;
    const cert = { ...body, hash: sha256(JSON.stringify(body)) };
    state.certificates.push(cert);
    return cert;
  }

  _schedule(selected) {
    const slices = [];
    const remaining = new Map(selected.map((o) => [o.id, o.size]));
    for (const obj of selected) obj.waitTicks = 0;
    while (remaining.size > 0) {
      const candidates = selected.filter((o) => remaining.has(o.id));
      let target = null;
      const capped = candidates.filter((o) => o.waitTicks >= this.state.waitCap).sort(byId);
      if (capped.length > 0) {
        target = capped[0];
      } else {
        const requesters = [...new Set(candidates.map((o) => o.requester))].sort();
        const totalWeight = requesters.reduce((acc, r) => acc + this.state.quotas[r].weight, 0);
        const totalServed = requesters.reduce((acc, r) => acc + this.state.quotas[r].completedBytes, 0);
        let bestRequester = requesters[0];
        let bestDeficit = -Infinity;
        for (const r of requesters) {
          const quota = this.state.quotas[r];
          const entitled = totalWeight === 0 ? 0 : (totalServed * quota.weight) / totalWeight;
          const deficit = entitled - quota.completedBytes;
          if (deficit > bestDeficit) {
            bestDeficit = deficit;
            bestRequester = r;
          }
        }
        target = candidates.filter((o) => o.requester === bestRequester).sort(byId)[0];
      }
      const bytes = Math.min(this.state.bandwidthPerTick, remaining.get(target.id));
      slices.push({ tick: this.state.tick, object: target.id, requester: target.requester, bytes });
      const left = remaining.get(target.id) - bytes;
      if (left === 0) remaining.delete(target.id);
      else remaining.set(target.id, left);
      this.state.quotas[target.requester].completedBytes += bytes;
      for (const obj of candidates) {
        if (obj.id !== target.id) obj.waitTicks += 1;
      }
      this.state.tick += 1;
    }
    return slices;
  }

  restore(options = {}) {
    const failAt = options.failAt || null;
    return this._transact(() => {
      this._checkCycles();
      const objects = this.state.objects;
      const staged = Object.values(objects).filter((o) => o.status === 'staged');
      const pending = Object.values(objects).filter((o) => o.status === 'pending');
      const eligible = pending.filter((o) => o.parent === null || objects[o.parent].status === 'staged');
      const result = { placement: [], slices: [], evicted: [], failures: [], certificates: [], value: 0 };
      if (eligible.length === 0) return result;

      const maxRetention = Math.max(...eligible.map((o) => o.retention));
      const evictable = staged
        .filter((o) => !o.locked && o.retention < maxRetention)
        .sort((a, b) => a.retention - b.retention || byId(a, b));
      const evictableIds = new Set(evictable.map((o) => o.id));
      const pinnedBytes = staged.filter((o) => !evictableIds.has(o.id))
        .reduce((acc, o) => acc + o.size, 0);
      const freeCapacity = this.state.stagingCapacity - pinnedBytes;

      const { selected, value } = knapsack(eligible, freeCapacity);
      result.value = value;
      const selectedIds = new Set(selected.map((o) => o.id));
      for (const obj of eligible) {
        if (!selectedIds.has(obj.id) && obj.size > freeCapacity) {
          obj.failReason = 'disk-full';
          result.failures.push({ id: obj.id, reason: 'disk-full' });
        }
      }

      const stagedBytes = staged.reduce((acc, o) => acc + o.size, 0);
      const selectedBytes = selected.reduce((acc, o) => acc + o.size, 0);
      let need = selectedBytes - (this.state.stagingCapacity - stagedBytes);
      const evicted = [];
      for (const victim of evictable) {
        if (need <= 0) break;
        victim.status = 'evicted';
        victim.offset = null;
        victim.verified = false;
        evicted.push(victim);
        need -= victim.size;
        this.state.evictions.push({
          objectId: victim.id,
          generation: this.state.generation,
          reason: 'preemption',
        });
      }
      if (need > 0) {
        throw new DiskFullError(`staging full: short ${need} bytes after preemption`);
      }

      let offset = 0;
      const remaining = staged.filter((o) => o.status === 'staged').sort(byId);
      for (const obj of remaining) {
        obj.offset = offset;
        offset += obj.size;
      }
      for (const obj of [...selected].sort(byId)) {
        obj.offset = offset;
        offset += obj.size;
        result.placement.push({ id: obj.id, offset: obj.offset, size: obj.size });
      }

      // fault point 1: write staging (bandwidth slices move bytes into staging)
      result.slices = this._schedule(selected);
      this._fault('staging', failAt);

      // fault point 2: write index (object status transitions)
      for (const obj of selected) {
        obj.status = 'staged';
        obj.stagedBytes = obj.size;
        obj.waitTicks = 0;
      }
      this._fault('index', failAt);

      // fault point 3: write certificate (eviction proofs + restore certificates)
      for (const victim of evicted) {
        result.certificates.push(this._cert('evict', victim.id, { reason: 'preemption' }));
      }
      for (const obj of [...selected].sort(byId)) {
        result.certificates.push(this._cert('restore', obj.id, { checksum: obj.checksum }));
      }
      this._fault('cert', failAt);

      result.evicted = evicted.map((o) => o.id);
      return result;
    });
  }

  correct(id, checksum) {
    if (!checksum || typeof checksum !== 'string') {
      throw new ArchiveError('BAD_REQUEST', 'correct requires a checksum string');
    }
    return this._transact(() => {
      const obj = this._require(id);
      obj.checksum = checksum;
      const affected = this._withDescendants(id);
      for (const entry of affected) {
        if (entry.status === 'staged') entry.verified = false;
      }
      const certificate = this._cert('correct', id, { checksum });
      return { corrected: id, affected: affected.map((o) => o.id), certificate };
    });
  }

  evict(id) {
    return this._transact(() => {
      const obj = this._require(id);
      if (obj.locked) throw new ArchiveError('LOCKED', `object is locked: ${id}`);
      if (obj.status !== 'staged') throw new ArchiveError('NOT_STAGED', `object not staged: ${id}`);
      obj.status = 'evicted';
      obj.offset = null;
      obj.verified = false;
      this.state.evictions.push({ objectId: id, generation: this.state.generation, reason: 'manual' });
      const certificate = this._cert('evict', id, { reason: 'manual' });
      return { evicted: id, certificate };
    });
  }

  verify() {
    const objects = this.state.objects;
    const results = [];
    for (const id of Object.keys(objects).sort()) {
      const obj = objects[id];
      if (obj.status !== 'staged') {
        results.push({ id, status: obj.status, ok: null, verifyCount: obj.verifyCount });
        continue;
      }
      if (!obj.verified) {
        obj.lastOk = sha256(obj.data) === obj.checksum;
        obj.verified = true;
        obj.verifyCount += 1;
      }
      results.push({ id, status: obj.status, ok: obj.lastOk, verifyCount: obj.verifyCount });
    }
    let prev = 'genesis';
    let chainOk = true;
    for (const cert of this.state.certificates) {
      const { hash, ...body } = cert;
      if (cert.prev !== prev || sha256(JSON.stringify(body)) !== hash) {
        chainOk = false;
        break;
      }
      prev = hash;
    }
    const failures = results.filter((r) => r.ok === false).map((r) => r.id);
    return {
      ok: chainOk && failures.length === 0,
      chainOk,
      failures,
      objects: results,
      certificates: structuredClone(this.state.certificates),
    };
  }

  undo(generations = 1) {
    if (!Number.isInteger(generations) || generations < 1 || generations > this.history.length) {
      throw new ArchiveError('UNDO_RANGE', `cannot undo ${generations} generation(s)`);
    }
    const snapshot = this.history[this.history.length - generations];
    this.history.length -= generations;
    this._restore(snapshot);
    return { generation: this.state.generation, undone: generations };
  }
}

module.exports = {
  Archive,
  ArchiveError,
  ChecksumError,
  DiskFullError,
  CycleError,
  FaultError,
  EXIT_DATA_ERR,
  sha256,
};

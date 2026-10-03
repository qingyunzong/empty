'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class PlatformError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashOf(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const NODE_FIELDS = ['owner', 'cpu', 'mem', 'deps', 'bytes', 'duration', 'materialized', 'retries'];

class Platform {
  constructor(options = {}) {
    this.cpu = options.cpu ?? 8;
    this.mem = options.mem ?? 8;
    this.quotas = Object.assign({}, options.quotas);
    this.agingRate = options.agingRate ?? 1;
    this.nodes = new Map();
    this.ownerBytes = new Map();
    this.time = 0;
    this.generation = 0;
    this.committed = []; // [{generation, root, snapshot}]
    this.stateDir = options.stateDir || null;
  }

  quotaFor(owner) {
    const q = this.quotas[owner];
    return q === undefined ? Infinity : q;
  }

  bytesOf(owner) {
    return this.ownerBytes.get(owner) || 0;
  }

  _require(id) {
    const node = this.nodes.get(id);
    if (!node) throw new PlatformError('UNKNOWN_NODE', `unknown node: ${id}`);
    return node;
  }

  _dependents() {
    const map = new Map();
    for (const node of this.nodes.values()) {
      for (const dep of node.deps) {
        if (!map.has(dep)) map.set(dep, []);
        map.get(dep).push(node.id);
      }
    }
    return map;
  }

  _descendantCounts() {
    const dependents = this._dependents();
    const counts = new Map();
    for (const id of this.nodes.keys()) {
      const seen = new Set();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const next of dependents.get(cur) || []) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      counts.set(id, seen.size);
    }
    return counts;
  }

  _checkCycle() {
    const color = new Map([...this.nodes.keys()].map((id) => [id, 0]));
    const visit = (id) => {
      color.set(id, 1);
      for (const dep of this.nodes.get(id).deps) {
        if (!this.nodes.has(dep)) continue; // forward reference: pending, not a cycle yet
        if (color.get(dep) === 1) return true;
        if (color.get(dep) === 0 && visit(dep)) return true;
      }
      color.set(id, 2);
      return false;
    };
    for (const id of this.nodes.keys()) {
      if (color.get(id) === 0 && visit(id)) return true;
    }
    return false;
  }

  submit(spec) {
    const { id } = spec || {};
    if (!id) throw new PlatformError('INVALID_SPEC', 'node id is required');
    if (this.nodes.has(id)) {
      throw new PlatformError('DUPLICATE_SUBMIT', `duplicate submit: ${id}`);
    }
    const node = {
      id,
      owner: spec.owner ?? 'default',
      cpu: spec.cpu ?? 1,
      mem: spec.mem ?? 1,
      deps: [...(spec.deps ?? [])],
      bytes: spec.bytes ?? 1,
      duration: spec.duration ?? 1,
      materialized: spec.materialized ?? false,
      retries: spec.retries ?? 0,
      failures: spec.failures ?? 0, // injected failures left (testing hook)
      retriesUsed: 0,
      attempts: 0,
      status: 'pending',
      waitSince: this.time,
      startedAt: null,
      completedAt: null,
    };
    if (node.cpu > this.cpu || node.mem > this.mem) {
      throw new PlatformError(
        'RESOURCE_EXCEEDS_MACHINE',
        `node ${id} requires ${node.cpu}cpu/${node.mem}mem, machine has ${this.cpu}cpu/${this.mem}mem`,
      );
    }
    this.nodes.set(id, node);
    if (this._checkCycle()) {
      this.nodes.delete(id);
      throw new PlatformError('CYCLE_DEPENDENCY', `dependency cycle involving ${id}`);
    }
    return node;
  }

  _resetNode(node) {
    if (node.status === 'completed') {
      this.ownerBytes.set(node.owner, this.bytesOf(node.owner) - node.bytes);
    }
    node.status = 'pending';
    node.completedAt = null;
    node.startedAt = null;
    node.waitSince = this.time;
  }

  invalidate(id) {
    this._require(id);
    const dependents = this._dependents();
    const set = [];
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur) || !this.nodes.has(cur)) continue;
      seen.add(cur);
      set.push(cur);
      for (const next of dependents.get(cur) || []) stack.push(next);
    }
    for (const nid of set) this._resetNode(this.nodes.get(nid));
    return set.sort();
  }

  correct(id, patch = {}) {
    const node = this._require(id);
    const next = Object.assign(pickDefined(node), pickDefined(patch));
    if (next.cpu > this.cpu || next.mem > this.mem) {
      throw new PlatformError(
        'RESOURCE_EXCEEDS_MACHINE',
        `corrected node ${id} requires ${next.cpu}cpu/${next.mem}mem, machine has ${this.cpu}cpu/${this.mem}mem`,
      );
    }
    if (patch.deps !== undefined) {
      const saved = node.deps;
      node.deps = [...patch.deps];
      const cyclic = this._checkCycle();
      node.deps = saved;
      if (cyclic) {
        throw new PlatformError('CYCLE_DEPENDENCY', `correction of ${id} introduces a dependency cycle`);
      }
    }
    const invalidated = this.invalidate(id);
    for (const field of NODE_FIELDS) {
      if (patch[field] !== undefined) {
        node[field] = field === 'deps' ? [...patch[field]] : patch[field];
      }
    }
    return invalidated;
  }

  preempt() {
    const killed = [];
    for (const node of this.nodes.values()) {
      if (node.status === 'running' && !node.materialized) {
        node.status = 'pending';
        node.startedAt = null;
        node.waitSince = this.time;
        killed.push(node.id);
      }
    }
    return killed.sort();
  }

  // Optimal completion planning under owner quotas. When the number of pending
  // nodes is small (<= 12) we enumerate every subset and pick a maximum
  // cardinality feasible one (deps closed, per-owner quota respected), so the
  // scheduler never wastes quota on nodes that block longer chains. For larger
  // fronts we fall back to the greedy fairness heuristics only.
  _planCompletionSet() {
    const pending = [...this.nodes.values()].filter((n) => n.status === 'pending');
    if (pending.length === 0 || pending.length > 12) return null;
    const running = [...this.nodes.values()].filter((n) => n.status === 'running');
    const inFlight = new Map();
    for (const n of running) inFlight.set(n.owner, (inFlight.get(n.owner) || 0) + n.bytes);
    const completedIds = new Set(
      [...this.nodes.values()].filter((n) => n.status === 'completed').map((n) => n.id),
    );
    let bestMask = 0;
    let bestCount = -1;
    let bestBytes = -1;
    for (let mask = 0; mask < 1 << pending.length; mask++) {
      let count = 0;
      let bytes = 0;
      let ok = true;
      const chosen = new Set();
      const ownerSum = new Map();
      for (let i = 0; i < pending.length; i++) {
        if (!(mask & (1 << i))) continue;
        const node = pending[i];
        chosen.add(node.id);
        count++;
        bytes += node.bytes;
        ownerSum.set(node.owner, (ownerSum.get(node.owner) || 0) + node.bytes);
      }
      for (const node of pending) {
        if (!chosen.has(node.id)) continue;
        for (const dep of node.deps) {
          if (completedIds.has(dep)) continue;
          const depNode = this.nodes.get(dep);
          if (!depNode || depNode.status === 'failed') {
            ok = false;
            break;
          }
          if (depNode.status === 'running') continue;
          if (!chosen.has(dep)) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      for (const [owner, sum] of ownerSum) {
        const total = this.bytesOf(owner) + (inFlight.get(owner) || 0) + sum;
        if (total > this.quotaFor(owner)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (count > bestCount || (count === bestCount && bytes > bestBytes)) {
        bestCount = count;
        bestBytes = bytes;
        bestMask = mask;
      }
    }
    const plan = new Set();
    for (let i = 0; i < pending.length; i++) {
      if (bestMask & (1 << i)) plan.add(pending[i].id);
    }
    return plan;
  }

  schedule(options = {}) {
    const stopAt = options.stopAt ?? Infinity;
    const events = [];
    const descCounts = this._descendantCounts();
    for (;;) {
      const plan = this._planCompletionSet();
      const running = [...this.nodes.values()].filter((n) => n.status === 'running');
      let usedCpu = running.reduce((s, n) => s + n.cpu, 0);
      let usedMem = running.reduce((s, n) => s + n.mem, 0);
      const inFlight = new Map();
      for (const n of running) inFlight.set(n.owner, (inFlight.get(n.owner) || 0) + n.bytes);

      const completedIds = new Set(
        [...this.nodes.values()].filter((n) => n.status === 'completed').map((n) => n.id),
      );
      const ready = [...this.nodes.values()].filter(
        (n) =>
          n.status === 'pending' &&
          (plan === null || plan.has(n.id)) &&
          n.deps.every((d) => completedIds.has(d)) &&
          this.bytesOf(n.owner) + (inFlight.get(n.owner) || 0) + n.bytes <= this.quotaFor(n.owner),
      );
      // Cross-owner fairness: least completed bytes first, aged by wait time;
      // then prefer nodes that unlock more descendants, then cheaper, then id.
      ready.sort((a, b) => {
        const ka = this.bytesOf(a.owner) - this.agingRate * (this.time - a.waitSince);
        const kb = this.bytesOf(b.owner) - this.agingRate * (this.time - b.waitSince);
        if (ka !== kb) return ka - kb;
        if (descCounts.get(a.id) !== descCounts.get(b.id)) return descCounts.get(b.id) - descCounts.get(a.id);
        if (a.bytes !== b.bytes) return a.bytes - b.bytes;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      for (const node of ready) {
        if (usedCpu + node.cpu > this.cpu || usedMem + node.mem > this.mem) continue;
        const ownerTotal = this.bytesOf(node.owner) + (inFlight.get(node.owner) || 0);
        if (ownerTotal + node.bytes > this.quotaFor(node.owner)) continue;
        usedCpu += node.cpu;
        usedMem += node.mem;
        inFlight.set(node.owner, ownerTotal + node.bytes);
        node.status = 'running';
        node.attempts += 1;
        node.startedAt = this.time;
        node.endsAt = this.time + node.duration;
        events.push({ type: 'start', id: node.id, time: this.time, attempt: node.attempts });
      }
      const stillRunning = [...this.nodes.values()].filter((n) => n.status === 'running');
      if (stillRunning.length === 0) break;
      const nextEnd = Math.min(...stillRunning.map((n) => n.endsAt));
      if (nextEnd > stopAt) {
        this.time = stopAt;
        break;
      }
      this.time = nextEnd;
      for (const node of stillRunning.filter((n) => n.endsAt === nextEnd)) {
        if (node.failures > 0) {
          node.failures -= 1;
          node.retriesUsed += 1;
          events.push({ type: 'failure', id: node.id, time: this.time, attempt: node.attempts });
          if (node.retriesUsed <= node.retries) {
            node.status = 'pending';
            node.startedAt = null;
            node.waitSince = this.time;
            events.push({ type: 'retry', id: node.id, time: this.time });
          } else {
            node.status = 'failed';
          }
        } else {
          node.status = 'completed';
          node.completedAt = this.time;
          this.ownerBytes.set(node.owner, this.bytesOf(node.owner) + node.bytes);
          events.push({ type: 'complete', id: node.id, time: this.time });
        }
      }
    }
    return {
      events,
      completed: [...this.nodes.values()].filter((n) => n.status === 'completed').map((n) => n.id).sort(),
      time: this.time,
    };
  }

  serialize() {
    return {
      cpu: this.cpu,
      mem: this.mem,
      quotas: this.quotas,
      agingRate: this.agingRate,
      time: this.time,
      generation: this.generation,
      ownerBytes: Object.fromEntries([...this.ownerBytes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      nodes: [...this.nodes.values()]
        .map((n) => ({ ...n }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
  }

  stateRoot() {
    return hashOf(this.serialize());
  }

  static deserialize(data, options = {}) {
    const platform = new Platform({
      cpu: data.cpu,
      mem: data.mem,
      quotas: data.quotas,
      agingRate: data.agingRate,
      stateDir: options.stateDir,
    });
    platform.time = data.time;
    platform.generation = data.generation;
    platform.ownerBytes = new Map(Object.entries(data.ownerBytes || {}));
    for (const node of data.nodes || []) platform.nodes.set(node.id, { ...node });
    return platform;
  }

  commit(hooks = {}) {
    const generation = this.generation + 1;
    const snapshot = Object.assign(this.serialize(), { generation });
    const root = hashOf(snapshot);
    if (this.stateDir) {
      fs.mkdirSync(path.join(this.stateDir, 'generations'), { recursive: true });
      const journalPath = path.join(this.stateDir, 'journal.json');
      const payload = JSON.stringify({
        committed: [...this.committed.map((c) => ({ generation: c.generation, root: c.root })), { generation, root }],
        current: snapshot,
      });
      const fd = fs.openSync(journalPath, 'w');
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if (hooks.crashAfter === 'journal') {
        const err = new Error('simulated crash after journal write');
        err.code = 'SIMULATED_CRASH';
        throw err;
      }
      fs.renameSync(journalPath, path.join(this.stateDir, 'current.json'));
      fs.writeFileSync(path.join(this.stateDir, 'generations', `${generation}.json`), JSON.stringify(snapshot));
    }
    this.generation = generation;
    this.committed.push({ generation, root, snapshot });
    return { generation, root };
  }

  undo() {
    if (this.committed.length === 0) {
      throw new PlatformError('NOTHING_TO_UNDO', 'no committed generation to roll back to');
    }
    this.committed.pop();
    const target = this.committed[this.committed.length - 1];
    const restored = target
      ? Platform.deserialize(target.snapshot, { stateDir: this.stateDir })
      : new Platform({ cpu: this.cpu, mem: this.mem, quotas: this.quotas, agingRate: this.agingRate });
    this.nodes = restored.nodes;
    this.ownerBytes = restored.ownerBytes;
    this.time = restored.time;
    this.generation = restored.generation;
    if (this.stateDir) this._persistCurrent();
    return { generation: this.generation, root: this.stateRoot() };
  }

  _persistCurrent() {
    const journalPath = path.join(this.stateDir, 'journal.json');
    const payload = JSON.stringify({
      committed: this.committed.map((c) => ({ generation: c.generation, root: c.root })),
      current: this.serialize(),
    });
    fs.writeFileSync(journalPath, payload);
    fs.renameSync(journalPath, path.join(this.stateDir, 'current.json'));
  }

  saveWork() {
    if (!this.stateDir) return;
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = path.join(this.stateDir, 'work.json.tmp');
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        committed: this.committed.map((c) => ({ generation: c.generation, root: c.root })),
        work: this.serialize(),
      }),
    );
    fs.renameSync(tmp, path.join(this.stateDir, 'work.json'));
  }

  static load(stateDir) {
    const currentPath = path.join(stateDir, 'current.json');
    const workPath = path.join(stateDir, 'work.json');
    const journalPath = path.join(stateDir, 'journal.json');
    // A leftover journal means the commit crashed before the atomic rename:
    // discard it so recovery sees either the whole old generation or the whole new one.
    if (fs.existsSync(journalPath)) fs.rmSync(journalPath);
    let data = null;
    let committedMeta = [];
    if (fs.existsSync(workPath)) {
      const parsed = JSON.parse(fs.readFileSync(workPath, 'utf8'));
      data = parsed.work;
      committedMeta = parsed.committed || [];
    } else if (fs.existsSync(currentPath)) {
      const parsed = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
      data = parsed.current;
      committedMeta = parsed.committed || [];
    } else {
      return null;
    }
    const platform = Platform.deserialize(data, { stateDir });
    platform.committed = committedMeta.map((meta) => {
      const genPath = path.join(stateDir, 'generations', `${meta.generation}.json`);
      const snapshot = fs.existsSync(genPath) ? JSON.parse(fs.readFileSync(genPath, 'utf8')) : null;
      return { generation: meta.generation, root: meta.root, snapshot };
    });
    return platform;
  }
}

module.exports = { Platform, PlatformError, hashOf, canonicalize };

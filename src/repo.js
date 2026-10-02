import fs from 'node:fs';
import path from 'node:path';
import { canonical, hash, applyOps, applyChanges, diffStates, mergeStates, validateOps } from './model.js';
import { writeJsonAtomic, writeTextAtomic, readJson, readJsonOrNull, listJson } from './store.js';

export class RepoError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
    this.details = details;
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIRS = ['batches', 'versions', 'heads', 'state', 'views'];

// Repo layout under <root>:
//   batches/<batchId>.json    committed observation batches (content addressed)
//   versions/<versionId>.json version-graph nodes with certificates
//   heads/<branch>            branch head version id (updated last, atomically)
//   state/<versionId>.json    materialized tri-state cache per version
//   views/<name>.json         optional view definitions {branch, prefix}
//
// Commit durability order: batch object -> version object (parent pointers)
// -> state cache -> head pointer -> ack. On open, recovery re-links any head
// that is missing, stale, or not a tip, so a crash after the parent-pointer
// (version object) write never loses an acknowledged batch.
export class Repo {
  constructor(root) {
    this.root = root;
    for (const d of DIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
    this.recovered = [];
    this.#load();
  }

  #load() {
    this.batches = new Map();
    this.versions = new Map();
    this.heads = new Map();
    this._stateCache = new Map();
    for (const f of listJson(path.join(this.root, 'batches'))) {
      const b = readJson(path.join(this.root, 'batches', f));
      this.batches.set(b.id, b);
    }
    for (const f of listJson(path.join(this.root, 'versions'))) {
      const v = readJson(path.join(this.root, 'versions', f));
      this.versions.set(v.id, v);
    }
    try {
      for (const f of fs.readdirSync(path.join(this.root, 'heads'))) {
        this.heads.set(f, fs.readFileSync(path.join(this.root, 'heads', f), 'utf8').trim());
      }
    } catch { /* no heads yet */ }
    this.#recover();
  }

  #recover() {
    const byBranch = new Map();
    for (const v of this.versions.values()) {
      const l = byBranch.get(v.branch) ?? [];
      l.push(v);
      byBranch.set(v.branch, l);
    }
    for (const [branch, vers] of byBranch) {
      const referencedAsParent = new Set();
      for (const v of vers) for (const p of v.parents) referencedAsParent.add(p);
      const tips = vers.filter((v) => !referencedAsParent.has(v.id));
      const head = this.heads.get(branch);
      const headOk =
        head &&
        this.versions.has(head) &&
        this.versions.get(head).branch === branch &&
        !referencedAsParent.has(head);
      if (!headOk && tips.length > 0) {
        tips.sort((x, y) => y.vclock - x.vclock || (x.id < y.id ? -1 : 1));
        this.#writeHead(branch, tips[0].id);
        this.heads.set(branch, tips[0].id);
        this.recovered.push({ branch, head: tips[0].id });
      }
    }
    for (const [branch, head] of [...this.heads]) {
      if (!this.versions.has(head)) {
        this.heads.delete(branch);
        fs.rmSync(path.join(this.root, 'heads', branch), { force: true });
      }
    }
  }

  // --- inter-process lock (multiple analyzer processes, one offline repo) ---
  #acquireLock() {
    const file = path.join(this.root, 'lock');
    const ia = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        return fs.openSync(file, 'wx');
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > 30000) {
            fs.rmSync(file, { force: true }); // stale lock from a crashed process
            continue;
          }
        } catch { /* lock vanished */ }
        if (Date.now() > deadline) throw new RepoError('E_LOCKED', 'repo lock held by another process');
        Atomics.wait(ia, 0, 0, 5);
      }
    }
  }

  #releaseLock(fd) {
    fs.closeSync(fd);
    fs.rmSync(path.join(this.root, 'lock'), { force: true });
  }

  #writeHead(branch, vid) {
    writeTextAtomic(path.join(this.root, 'heads', branch), vid + '\n');
  }

  #writeState(vid, state) {
    const entries = [...state.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    writeJsonAtomic(path.join(this.root, 'state', `${vid}.json`), entries);
  }

  getState(vid) {
    if (this._stateCache.has(vid)) return this._stateCache.get(vid);
    const disk = readJsonOrNull(path.join(this.root, 'state', `${vid}.json`));
    let state;
    if (disk) {
      state = new Map(disk);
    } else {
      const v = this.versions.get(vid);
      if (!v) throw new RepoError('E_BAD_PARENT', `unknown version ${vid}`);
      state = v.parents.length ? new Map(this.getState(v.parents[0])) : new Map();
      applyChanges(state, v.changes);
      this.#writeState(vid, state);
    }
    this._stateCache.set(vid, state);
    return state;
  }

  ancestors(vid) {
    const out = new Set();
    const stack = [vid];
    while (stack.length) {
      const id = stack.pop();
      if (out.has(id)) continue;
      out.add(id);
      const v = this.versions.get(id);
      if (v) stack.push(...v.parents);
    }
    return out;
  }

  lca(a, b) {
    const ancA = this.ancestors(a);
    const ancB = this.ancestors(b);
    const common = [...ancA].filter((x) => ancB.has(x));
    const ancCache = new Map();
    const ancOf = (id) => {
      if (!ancCache.has(id)) ancCache.set(id, this.ancestors(id));
      return ancCache.get(id);
    };
    return common.filter((c) => !common.some((d) => d !== c && ancOf(d).has(c)));
  }

  commitBatch(input, opts = {}) {
    const fd = this.#acquireLock();
    try {
      this.#load();
      return this.#commitBatch(input, opts);
    } finally {
      this.#releaseLock(fd);
    }
  }

  #commitBatch(input, opts) {
    if (!input || typeof input !== 'object') throw new RepoError('E_BAD_BATCH', 'batch must be an object');
    const { processId, clock, deps = [], ops = [] } = input;
    if (typeof processId !== 'string' || !Number.isInteger(clock)) {
      throw new RepoError('E_BAD_BATCH', 'batch needs processId (string) and clock (integer)');
    }
    if (!Array.isArray(deps)) throw new RepoError('E_BAD_BATCH', 'deps must be an array');
    validateOps(ops);

    const batchId = hash({ processId, clock, deps, ops });
    if (this.batches.has(batchId)) {
      const existing = [...this.versions.values()].find((v) => v.batch === batchId);
      return { batchId, versionId: existing?.id ?? null, branch: existing?.branch ?? null, duplicate: true };
    }
    for (const d of deps) {
      if (!this.batches.has(d)) {
        throw new RepoError('E_ORPHAN', `batch depends on unknown batch ${d}`, { dep: d });
      }
    }

    const branch = opts.branch ?? input.branch ?? 'main';
    if (!NAME_RE.test(branch)) throw new RepoError('E_BAD_PARENT', `invalid branch name ${branch}`);

    let parents;
    if (this.heads.has(branch)) {
      parents = [this.heads.get(branch)];
    } else if (input.from !== undefined) {
      const fromHead = this.heads.get(input.from);
      if (!fromHead) throw new RepoError('E_BAD_PARENT', `unknown source branch ${input.from}`);
      parents = [fromHead];
    } else {
      parents = [];
    }
    if (input.parents !== undefined) {
      const declared = [...input.parents].sort();
      for (const p of declared) {
        if (!this.versions.has(p)) throw new RepoError('E_BAD_PARENT', `unknown parent version ${p}`);
      }
      if (canonical(declared) !== canonical([...parents].sort())) {
        throw new RepoError('E_BAD_PARENT', 'declared parents do not match branch head', {
          expected: parents,
          declared,
        });
      }
    }

    const parentState = parents.length ? this.getState(parents[0]) : new Map();
    const state = new Map(parentState);
    const changes = applyOps(state, ops);
    const vclock = Math.max(clock, ...parents.map((p) => this.versions.get(p).vclock)) + 1;
    const vid = hash({ branch, parents: [...parents].sort(), batch: batchId });
    const version = { id: vid, branch, parents, batch: batchId, vclock, changes };

    writeJsonAtomic(path.join(this.root, 'batches', `${batchId}.json`), {
      id: batchId, processId, clock, deps, ops,
    });
    writeJsonAtomic(path.join(this.root, 'versions', `${vid}.json`), version);
    this.#writeState(vid, state);
    this.#writeHead(branch, vid); // ack point: batch is durable once this returns

    this.batches.set(batchId, { id: batchId, processId, clock, deps, ops });
    this.versions.set(vid, version);
    this.heads.set(branch, vid);
    this._stateCache.set(vid, state);
    return { batchId, versionId: vid, branch, duplicate: false };
  }

  mergeBranches(a, b) {
    const fd = this.#acquireLock();
    try {
      this.#load();
      return this.#mergeBranches(a, b);
    } finally {
      this.#releaseLock(fd);
    }
  }

  #mergeBranches(a, b) {
    const ha = this.heads.get(a);
    const hb = this.heads.get(b);
    if (!ha) throw new RepoError('E_BAD_PARENT', `unknown branch ${a}`);
    if (!hb) throw new RepoError('E_BAD_PARENT', `unknown branch ${b}`);
    if (ha === hb) return { versionId: ha, merged: false, reason: 'identical' };
    const ancA = this.ancestors(ha);
    const ancB = this.ancestors(hb);
    if (ancA.has(hb)) return { versionId: ha, merged: false, reason: 'already-merged' };
    if (ancB.has(ha)) {
      this.#writeHead(a, hb);
      this.heads.set(a, hb);
      return { versionId: hb, merged: false, reason: 'fast-forward' };
    }
    const lcas = this.lca(ha, hb);
    const baseVid = lcas.length
      ? lcas.sort((x, y) => this.versions.get(y).vclock - this.versions.get(x).vclock)[0]
      : null;
    const baseState = baseVid ? this.getState(baseVid) : new Map();
    const { state, conflicts } = mergeStates(baseState, this.getState(ha), this.getState(hb));
    if (conflicts.length) {
      throw new RepoError('E_CONFLICT', `merge of ${a} and ${b} has ${conflicts.length} conflict(s)`, {
        conflicts,
        lca: lcas,
      });
    }
    const parents = [ha, hb].sort();
    const changes = diffStates(this.getState(ha), state);
    const vclock = Math.max(this.versions.get(ha).vclock, this.versions.get(hb).vclock) + 1;
    const vid = hash({ branch: a, parents, batch: null });
    const version = { id: vid, branch: a, parents, batch: null, vclock, changes };
    writeJsonAtomic(path.join(this.root, 'versions', `${vid}.json`), version);
    this.#writeState(vid, state);
    this.#writeHead(a, vid);
    this.versions.set(vid, version);
    this.heads.set(a, vid);
    this._stateCache.set(vid, state);
    return { versionId: vid, merged: true, lca: lcas };
  }

  forkinfo() {
    const branches = [...this.heads.keys()].sort().map((name) => {
      const head = this.heads.get(name);
      const versions = [...this.versions.values()].filter((v) => v.branch === name).length;
      return { name, head, vclock: this.versions.get(head).vclock, versions };
    });
    const pairs = [];
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        const a = branches[i].name;
        const b = branches[j].name;
        const ha = this.heads.get(a);
        const hb = this.heads.get(b);
        const ancA = this.ancestors(ha);
        const ancB = this.ancestors(hb);
        const lcas = this.lca(ha, hb);
        const baseVid = lcas.length
          ? lcas.sort((x, y) => this.versions.get(y).vclock - this.versions.get(x).vclock)[0]
          : null;
        const baseState = baseVid ? this.getState(baseVid) : new Map();
        const { conflicts } = mergeStates(baseState, this.getState(ha), this.getState(hb));
        pairs.push({
          a,
          b,
          lca: lcas,
          ahead: {
            [a]: [...ancA].filter((x) => !ancB.has(x)).length,
            [b]: [...ancB].filter((x) => !ancA.has(x)).length,
          },
          conflicts,
        });
      }
    }
    return { branches, pairs, recovered: this.recovered };
  }

  viewDef(name) {
    if (!NAME_RE.test(name)) throw new RepoError('E_BAD_PARENT', `invalid view name ${name}`);
    return readJsonOrNull(path.join(this.root, 'views', `${name}.json`));
  }

  viewRows(branch, prefix = '') {
    const head = this.heads.get(branch);
    if (!head) throw new RepoError('E_BAD_PARENT', `unknown branch ${branch}`);
    const state = this.getState(head);
    const rows = {};
    for (const [k, tri] of [...state.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (tri.t === 'a' && k.startsWith(prefix)) rows[k] = tri.v;
    }
    return rows;
  }

  getVersion(vid) {
    return this.versions.get(vid) ?? null;
  }
}

'use strict';

class StoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

// Word tokens plus per-character terms for CJK runs (no whitespace word
// boundaries in Chinese/Japanese), so phrase queries can use the index for
// candidate narrowing and then verify the exact substring on visible text.
function tokenize(text) {
  const words = String(text).toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
  const terms = new Set();
  for (const word of words) {
    terms.add(word);
    if (CJK.test(word)) {
      for (const ch of word) if (CJK.test(ch)) terms.add(ch);
    }
  }
  return [...terms];
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

class Store {
  constructor() {
    this.versions = new Map(); // id -> {id, seq, clock, parents, branch, ops, message}
    this.branches = new Map(); // name -> version id
    this.counter = 0;
    this.postingCounter = 0;
    this.index = new Map(); // term -> Map(doc -> [{v, op, n}])
  }

  _needVersion(id) {
    if (!this.versions.has(id)) {
      throw new StoreError('E_VERSION', `unknown version: ${id}`);
    }
  }

  _resolveRef(ref) {
    if (this.branches.has(ref)) return this.branches.get(ref);
    if (this.versions.has(ref)) return ref;
    throw new StoreError('E_VERSION', `unknown version or branch: ${ref}`);
  }

  // ---- version graph -------------------------------------------------------

  visibleVersions(asOf) {
    this._needVersion(asOf);
    const seen = new Set();
    const stack = [asOf];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const parent of this.versions.get(id).parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(a, b) {
    this._needVersion(a);
    this._needVersion(b);
    return a !== b && this.visibleVersions(b).has(a);
  }

  // Concurrency = absence of causal order in either direction. Arrival order
  // (seq) is never used to decide concurrency.
  areConcurrent(a, b) {
    this._needVersion(a);
    this._needVersion(b);
    return a !== b && !this.visibleVersions(b).has(a) && !this.visibleVersions(a).has(b);
  }

  _lca(a, b) {
    const ancA = this.visibleVersions(a);
    const ancB = this.visibleVersions(b);
    const common = [...ancA].filter((id) => ancB.has(id));
    const maximal = common.filter(
      (x) => !common.some((y) => x !== y && this.visibleVersions(y).has(x))
    );
    maximal.sort((x, y) => {
      const vx = this.versions.get(x);
      const vy = this.versions.get(y);
      return vy.clock - vx.clock || vy.seq - vx.seq;
    });
    return maximal[0];
  }

  // ---- state replay --------------------------------------------------------

  // Replay order is (clock, seq). clock strictly increases along every causal
  // edge (enforced by E_CLOCK), so this is a topological order. The seq
  // tiebreak only orders causally unrelated versions and never decides
  // conflicts: same-field concurrent writes must be resolved by an explicit
  // merge commit, whose higher clock replays last.
  _stateAt(asOf) {
    const visible = this.visibleVersions(asOf);
    const ordered = [...visible]
      .map((id) => this.versions.get(id))
      .sort((x, y) => x.clock - y.clock || x.seq - y.seq);
    const docs = new Map();
    for (const version of ordered) {
      for (const op of version.ops) {
        if (op.type === 'set') {
          let fields = docs.get(op.doc);
          if (!fields) {
            fields = new Map();
            docs.set(op.doc, fields);
          }
          fields.set(op.field, op.value);
        } else if (op.type === 'del') {
          const fields = docs.get(op.doc);
          if (fields) {
            fields.delete(op.field);
            if (fields.size === 0) docs.delete(op.doc);
          }
        }
      }
    }
    return docs;
  }

  documentsAt(asOf) {
    const out = {};
    for (const [doc, fields] of this._stateAt(asOf)) {
      out[doc] = Object.fromEntries(fields);
    }
    return out;
  }

  docStateAt(doc, asOf) {
    const fields = this._stateAt(asOf).get(doc);
    return fields ? Object.fromEntries(fields) : undefined;
  }

  // ---- posting index (incremental append, versioned tombstones) ------------

  _emit(term, doc, versionId, op) {
    let docMap = this.index.get(term);
    if (!docMap) {
      docMap = new Map();
      this.index.set(term, docMap);
    }
    let list = docMap.get(doc);
    if (!list) {
      list = [];
      docMap.set(doc, list);
    }
    list.push({ v: versionId, op, n: ++this.postingCounter });
  }

  _emitPostings(version) {
    const state = version.parents.length
      ? this._stateAt(version.parents[0])
      : new Map();
    for (const op of version.ops) {
      const fields = state.get(op.doc);
      const oldValue = fields ? fields.get(op.field) : undefined;
      if (op.type === 'set') {
        const newTerms = typeof op.value === 'string' ? tokenize(op.value) : [];
        const oldTerms = typeof oldValue === 'string' ? tokenize(oldValue) : [];
        for (const term of oldTerms) {
          if (!newTerms.includes(term)) this._emit(term, op.doc, version.id, 'del');
        }
        for (const term of newTerms) this._emit(term, op.doc, version.id, 'add');
        let target = state.get(op.doc);
        if (!target) {
          target = new Map();
          state.set(op.doc, target);
        }
        target.set(op.field, op.value);
      } else if (op.type === 'del') {
        const oldTerms = typeof oldValue === 'string' ? tokenize(oldValue) : [];
        for (const term of oldTerms) this._emit(term, op.doc, version.id, 'del');
        const target = state.get(op.doc);
        if (target) {
          target.delete(op.field);
          if (target.size === 0) state.delete(op.doc);
        }
      }
    }
  }

  _cmpEntry(a, b) {
    const va = this.versions.get(a.v);
    const vb = this.versions.get(b.v);
    return va.clock - vb.clock || va.seq - vb.seq || a.n - b.n;
  }

  _effectiveOp(list, visible) {
    let best = null;
    for (const entry of list) {
      if (visible.has(entry.v) && (!best || this._cmpEntry(entry, best) > 0)) {
        best = entry;
      }
    }
    return best ? best.op : null;
  }

  _docsWithTerm(term, visible) {
    const docMap = this.index.get(term);
    const out = new Set();
    if (!docMap) return out;
    for (const [doc, list] of docMap) {
      if (this._effectiveOp(list, visible) === 'add') out.add(doc);
    }
    return out;
  }

  // Phrase query filtered by version visibility: the index narrows candidate
  // docs to those visibly containing every term at asOf, then the phrase is
  // verified against the reconstructed visible field text.
  queryPhrase(phrase, { asOf } = {}) {
    const visible = this.visibleVersions(asOf);
    // Narrowing terms: non-CJK words as-is; CJK runs as single characters
    // (the index stores per-character terms for CJK). Exact phrase order is
    // verified afterwards against the reconstructed visible text.
    const terms = [];
    for (const word of String(phrase).toLowerCase().split(TOKEN_SPLIT).filter(Boolean)) {
      if (CJK.test(word)) {
        for (const ch of word) if (CJK.test(ch)) terms.push(ch);
        const ascii = word.split(CJK).filter(Boolean);
        for (const piece of ascii) terms.push(piece);
      } else {
        terms.push(word);
      }
    }
    if (!terms.length) return [];
    let candidates = null;
    for (const term of terms) {
      const docs = this._docsWithTerm(term, visible);
      candidates =
        candidates === null
          ? docs
          : new Set([...candidates].filter((doc) => docs.has(doc)));
      if (candidates.size === 0) return [];
    }
    const needle = String(phrase).toLowerCase();
    const state = this._stateAt(asOf);
    const out = [];
    for (const doc of candidates) {
      const fields = state.get(doc);
      if (!fields) continue;
      for (const value of fields.values()) {
        if (typeof value === 'string' && value.toLowerCase().includes(needle)) {
          out.push(doc);
          break;
        }
      }
    }
    return out.sort();
  }

  // Compaction removes only postings that are provably invisible to every
  // possible as_of query: an entry is dropped iff the effective posting for
  // its (term, doc) pair is identical at every version with and without it.
  // Tombstones that are still the latest visible entry anywhere are kept.
  compact() {
    const ids = [...this.versions.keys()];
    const closures = new Map(ids.map((id) => [id, this.visibleVersions(id)]));
    let removed = 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (const [term, docMap] of this.index) {
        for (const [doc, list] of docMap) {
          for (let i = 0; i < list.length; i++) {
            const rest = list.slice(0, i).concat(list.slice(i + 1));
            let safe = true;
            for (const id of ids) {
              const vis = closures.get(id);
              if (this._effectiveOp(list, vis) !== this._effectiveOp(rest, vis)) {
                safe = false;
                break;
              }
            }
            if (safe) {
              list.splice(i, 1);
              i--;
              removed++;
              changed = true;
            }
          }
          if (list.length === 0) docMap.delete(doc);
        }
        if (docMap.size === 0) this.index.delete(term);
      }
    }
    return { removed, terms: this.index.size };
  }

  // ---- mutations -----------------------------------------------------------

  _appendVersion({ branch, ops, clock, parents, message }) {
    const parentClocks = parents.map((p) => this.versions.get(p).clock);
    const maxParent = parentClocks.length ? Math.max(...parentClocks) : 0;
    let lamport;
    if (clock === undefined) {
      lamport = maxParent + 1;
    } else {
      if (!Number.isInteger(clock) || clock <= maxParent) {
        throw new StoreError(
          'E_CLOCK',
          `clock ${clock} must be an integer greater than parent clock ${maxParent}`
        );
      }
      lamport = clock;
    }
    const id = `v${++this.counter}`;
    const version = {
      id,
      seq: this.counter,
      clock: lamport,
      parents: [...parents],
      branch,
      ops,
      message: message || '',
    };
    this.versions.set(id, version);
    this.branches.set(branch, id);
    this._emitPostings(version);
    return version;
  }

  commit({ branch = 'main', ops = [], clock, message } = {}) {
    let parents;
    if (this.branches.has(branch)) {
      parents = [this.branches.get(branch)];
    } else if (this.versions.size === 0) {
      parents = [];
    } else {
      throw new StoreError('E_VERSION', `unknown branch: ${branch}`);
    }
    return this._appendVersion({ branch, ops, clock, parents, message });
  }

  createBranch(name, fromRef) {
    if (this.branches.has(name)) {
      throw new StoreError('E_VERSION', `branch already exists: ${name}`);
    }
    this.branches.set(name, this._resolveRef(fromRef));
    return { branch: name, tip: this.branches.get(name) };
  }

  // Undo never deletes history: it appends a new commit whose ops invert the
  // net effect of the target version (fields restored to their pre-version
  // values, added fields removed, removed fields restored).
  undo({ branch = 'main', version, clock, message } = {}) {
    if (!this.branches.has(branch)) {
      throw new StoreError('E_VERSION', `unknown branch: ${branch}`);
    }
    this._needVersion(version);
    const target = this.versions.get(version);
    const baseState = target.parents.length
      ? this._stateAt(target.parents[0])
      : new Map();
    const touched = new Map();
    for (const op of target.ops) {
      touched.set(`${op.doc} ${op.field}`, op);
    }
    const ops = [];
    for (const op of touched.values()) {
      const fields = baseState.get(op.doc);
      const base = fields ? fields.get(op.field) : undefined;
      if (base === undefined) ops.push({ type: 'del', doc: op.doc, field: op.field });
      else ops.push({ type: 'set', doc: op.doc, field: op.field, value: base });
    }
    return this._appendVersion({
      branch,
      ops,
      clock,
      parents: [this.branches.get(branch)],
      message: message || `undo ${version}`,
    });
  }

  merge({ into = 'main', from, resolutions = {}, clock, message } = {}) {
    if (!this.branches.has(into)) {
      throw new StoreError('E_VERSION', `unknown branch: ${into}`);
    }
    if (!this.branches.has(from)) {
      throw new StoreError('E_VERSION', `unknown branch: ${from}`);
    }
    const tipA = this.branches.get(into);
    const tipB = this.branches.get(from);
    if (tipA === tipB || this.visibleVersions(tipA).has(tipB)) {
      return { merged: false, reason: 'already-merged', version: this.versions.get(tipA) };
    }
    if (this.visibleVersions(tipB).has(tipA)) {
      this.branches.set(into, tipB);
      return { merged: false, reason: 'fast-forward', version: this.versions.get(tipB) };
    }
    const lca = this._lca(tipA, tipB);
    const base = this._stateAt(lca);
    const ours = this._stateAt(tipA);
    const theirs = this._stateAt(tipB);
    const docs = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const conflicts = [];
    const ops = [];
    for (const doc of docs) {
      const fieldNames = new Set();
      for (const state of [base, ours, theirs]) {
        const fields = state.get(doc);
        if (fields) for (const name of fields.keys()) fieldNames.add(name);
      }
      for (const field of fieldNames) {
        const vb = base.get(doc) ? base.get(doc).get(field) : undefined;
        const va = ours.get(doc) ? ours.get(doc).get(field) : undefined;
        const vt = theirs.get(doc) ? theirs.get(doc).get(field) : undefined;
        const changedOurs = !sameValue(va, vb);
        const changedTheirs = !sameValue(vt, vb);
        let merged;
        if (changedOurs && changedTheirs && !sameValue(va, vt)) {
          const key = `${doc}.${field}`;
          if (key in resolutions) {
            merged = resolutions[key] === null ? undefined : resolutions[key];
          } else {
            conflicts.push({
              doc,
              field,
              base: vb === undefined ? null : vb,
              ours: va === undefined ? null : va,
              theirs: vt === undefined ? null : vt,
            });
            continue;
          }
        } else if (changedOurs) {
          merged = va;
        } else if (changedTheirs) {
          merged = vt;
        } else {
          merged = vb;
        }
        if (!sameValue(merged, va)) {
          if (merged === undefined) ops.push({ type: 'del', doc, field });
          else ops.push({ type: 'set', doc, field, value: merged });
        }
      }
    }
    if (conflicts.length) {
      throw new StoreError(
        'E_CONFLICT',
        `merge of ${from} into ${into} has ${conflicts.length} unresolved conflict(s)`,
        { conflicts }
      );
    }
    const version = this._appendVersion({
      branch: into,
      ops,
      clock,
      parents: [tipA, tipB],
      message: message || `merge ${from} into ${into}`,
    });
    return { merged: true, version };
  }

  // ---- persistence ---------------------------------------------------------

  toJSON() {
    return {
      counter: this.counter,
      branches: [...this.branches],
      versions: [...this.versions.values()],
    };
  }

  static fromJSON(data) {
    const store = new Store();
    store.counter = data.counter;
    store.branches = new Map(data.branches);
    const versions = [...data.versions].sort((a, b) => a.seq - b.seq);
    for (const version of versions) store.versions.set(version.id, version);
    // The index is derived state; rebuild it by replaying every commit.
    for (const version of versions) store._emitPostings(version);
    return store;
  }
}

module.exports = { Store, StoreError, tokenize };

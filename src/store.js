// Versioned work-order store with Lamport causality, DAG history,
// conflict-detecting merge, inverse-op undo and an append-only phrase index.
// Standard library only.

export class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const ABSENT = Symbol('absent');

function cmpVersionId(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1));
}

function cloneFields(fields) {
  return { ...fields };
}

// Apply a single op to a working doc map: docId -> { fields, deleted }.
export function applyOp(docs, op) {
  switch (op.op) {
    case 'set': {
      let d = docs.get(op.doc);
      if (!d || d.deleted) {
        d = { fields: {}, deleted: false };
        docs.set(op.doc, d);
      }
      d.fields[op.field] = op.value;
      break;
    }
    case 'unset': {
      const d = docs.get(op.doc);
      if (d && !d.deleted) delete d.fields[op.field];
      break;
    }
    case 'delete': {
      docs.set(op.doc, { fields: {}, deleted: true });
      break;
    }
    case 'restore': {
      docs.set(op.doc, { fields: cloneFields(op.fields), deleted: false });
      break;
    }
    default:
      throw new StoreError('E_VERSION', `unknown op: ${op.op}`);
  }
}

function docText(fields) {
  return Object.keys(fields)
    .sort()
    .map((k) => String(fields[k]))
    .join('\n');
}

export class Store {
  constructor() {
    this.versions = new Map(); // id -> {id, lamport, parents, ops, branch, message}
    this.branches = new Map(); // name -> head version id
    this.counter = 0;
    this.clock = 0; // max lamport seen
    this.segments = [[]]; // append-only posting segments
  }

  _version(id) {
    const v = this.versions.get(id);
    if (!v) throw new StoreError('E_VERSION', `unknown version: ${id}`);
    return v;
  }

  _branch(name) {
    if (!this.branches.has(name)) {
      throw new StoreError('E_VERSION', `unknown branch: ${name}`);
    }
    return this.branches.get(name);
  }

  branchHead(name) {
    return this._branch(name);
  }

  createBranch(name, from = null) {
    if (this.branches.has(name)) {
      throw new StoreError('E_VERSION', `branch already exists: ${name}`);
    }
    if (from !== null) this._version(from);
    this.branches.set(name, from);
    return name;
  }

  _addVersion({ parents, ops, branch, message = '', lamport }) {
    const parentLamports = parents.map((id) => this._version(id).lamport);
    const minRequired = parentLamports.length ? Math.max(...parentLamports) + 1 : 1;
    let lam;
    if (lamport !== undefined && lamport !== null) {
      if (!Number.isInteger(lamport) || lamport < minRequired) {
        throw new StoreError(
          'E_CLOCK',
          `lamport ${lamport} must be an integer >= ${minRequired} (parents: ${parents.join(',') || 'none'})`,
        );
      }
      lam = lamport;
    } else {
      lam = Math.max(this.clock + 1, minRequired);
    }
    const id = `v${++this.counter}`;
    const v = { id, lamport: lam, parents: [...parents], ops, branch, message };
    this.versions.set(id, v);
    this.clock = Math.max(this.clock, lam);
    return v;
  }

  commit({ branch, ops, lamport, message }) {
    const head = this._branch(branch);
    const parents = head ? [head] : [];
    const v = this._addVersion({ parents, ops, branch, message, lamport });
    this.branches.set(branch, v.id);
    this._indexVersion(v);
    return v;
  }

  // --- causality -----------------------------------------------------------

  // Set of version ids visible from `id` (id included).
  ancestors(id) {
    this._version(id);
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.versions.get(cur).parents) stack.push(p);
    }
    return seen;
  }

  isAncestor(a, b) {
    return a === b || this.ancestors(b).has(a);
  }

  // Concurrent iff neither version causally precedes the other.
  concurrent(a, b) {
    return a !== b && !this.isAncestor(a, b) && !this.isAncestor(b, a);
  }

  lcas(a, b) {
    const ancA = this.ancestors(a);
    const ancB = this.ancestors(b);
    const common = [...ancA].filter((x) => ancB.has(x));
    return common.filter((x) => !common.some((y) => y !== x && this.isAncestor(x, y)));
  }

  // --- materialization -----------------------------------------------------

  _materializeSet(idSet) {
    const vs = [...idSet]
      .map((id) => this.versions.get(id))
      .sort((x, y) => x.lamport - y.lamport || cmpVersionId(x.id, y.id));
    const docs = new Map();
    for (const v of vs) for (const op of v.ops) applyOp(docs, op);
    const out = new Map();
    for (const [doc, d] of docs) {
      if (!d.deleted && Object.keys(d.fields).length > 0) out.set(doc, cloneFields(d.fields));
    }
    return out;
  }

  // Documents visible at a version: only its ancestor closure contributes.
  materialize(id) {
    return this._materializeSet(this.ancestors(id));
  }

  // --- merge ---------------------------------------------------------------

  _diff(base, head) {
    const changes = new Map(); // "doc.field" -> {doc, field, from, to}
    const docs = new Set([...base.keys(), ...head.keys()]);
    for (const doc of docs) {
      const bf = base.get(doc) || {};
      const hf = head.get(doc) || {};
      const fields = new Set([...Object.keys(bf), ...Object.keys(hf)]);
      for (const field of fields) {
        const bv = field in bf ? bf[field] : ABSENT;
        const hv = field in hf ? hf[field] : ABSENT;
        if (!Object.is(bv, hv)) {
          changes.set(`${doc}.${field}`, { doc, field, from: bv, to: hv });
        }
      }
    }
    return changes;
  }

  _applyChange(state, change) {
    const fields = { ...(state.get(change.doc) || {}) };
    if (change.to === ABSENT) delete fields[change.field];
    else fields[change.field] = change.to;
    if (Object.keys(fields).length === 0) state.delete(change.doc);
    else state.set(change.doc, fields);
  }

  _diffOps(from, to) {
    const ops = [];
    const docs = new Set([...from.keys(), ...to.keys()]);
    for (const doc of [...docs].sort()) {
      const cur = from.get(doc);
      const want = to.get(doc);
      if (cur && !want) {
        ops.push({ op: 'delete', doc });
        continue;
      }
      if (!cur && want) {
        for (const f of Object.keys(want).sort()) ops.push({ op: 'set', doc, field: f, value: want[f] });
        continue;
      }
      for (const f of Object.keys(want).sort()) {
        if (!Object.is(cur[f], want[f])) ops.push({ op: 'set', doc, field: f, value: want[f] });
      }
      for (const f of Object.keys(cur).sort()) {
        if (!(f in want)) ops.push({ op: 'unset', doc, field: f });
      }
    }
    return ops;
  }

  // Merge head of `from` branch into `branch`. Concurrent edits to the same
  // field with different outcomes are conflicts; unresolved conflicts raise
  // E_CONFLICT (never silently treated as "no solution").
  merge({ branch, from, resolutions = {}, lamport, message }) {
    const headA = this._branch(branch);
    const headB = this._branch(from);
    if (!headA || !headB) throw new StoreError('E_VERSION', 'both branches need at least one version');
    if (this.isAncestor(headB, headA)) return null; // already up to date

    const bases = this.lcas(headA, headB);
    const baseSet = new Set();
    for (const l of bases) for (const id of this.ancestors(l)) baseSet.add(id);
    const baseState = this._materializeSet(baseSet);
    const stateA = this.materialize(headA);
    const stateB = this.materialize(headB);

    const changesA = this._diff(baseState, stateA);
    const changesB = this._diff(baseState, stateB);

    const conflicts = [];
    for (const [key, ca] of changesA) {
      const cb = changesB.get(key);
      if (cb && !Object.is(ca.to, cb.to)) {
        conflicts.push({
          key,
          doc: ca.doc,
          field: ca.field,
          ours: ca.to === ABSENT ? null : ca.to,
          theirs: cb.to === ABSENT ? null : cb.to,
        });
      }
    }

    const unresolved = conflicts.filter((c) => !(c.key in resolutions));
    if (unresolved.length > 0) {
      throw new StoreError('E_CONFLICT', `unresolved conflicts: ${unresolved.map((c) => c.key).join(', ')}`, {
        conflicts: unresolved,
      });
    }

    const target = new Map([...baseState].map(([d, f]) => [d, cloneFields(f)]));
    for (const c of changesA.values()) this._applyChange(target, c);
    for (const [key, c] of changesB) {
      if (!conflicts.some((cf) => cf.key === key)) this._applyChange(target, c);
    }
    for (const c of conflicts) {
      const value = resolutions[c.key];
      this._applyChange(target, {
        doc: c.doc,
        field: c.field,
        to: value === null ? ABSENT : value,
      });
    }

    // The merge version's ops must transform the plain (lamport,id) replay of
    // everything it will see as ancestors -- not just branch A's state --
    // into the merged target, so materialization yields exactly `target`.
    const replaySet = new Set([...this.ancestors(headA), ...this.ancestors(headB)]);
    const replayBase = this._materializeSet(replaySet);
    const ops = this._diffOps(replayBase, target);
    const v = this._addVersion({
      parents: [headA, headB],
      ops,
      branch,
      message: message || `merge ${from} into ${branch}`,
      lamport,
    });
    this.branches.set(branch, v.id);
    this._indexVersion(v);
    return v;
  }

  // --- undo ----------------------------------------------------------------

  // Undo never deletes history: it appends a new version with inverse ops.
  undo({ branch, version, lamport, message }) {
    const v = this._version(version);
    if (v.parents.length !== 1) {
      throw new StoreError('E_VERSION', `cannot undo ${version}: expected exactly one parent`);
    }
    const parentState = this.materialize(v.parents[0]);
    const inverse = [];
    for (const op of [...v.ops].reverse()) {
      switch (op.op) {
        case 'set': {
          const old = parentState.get(op.doc)?.[op.field];
          inverse.push(
            old === undefined
              ? { op: 'unset', doc: op.doc, field: op.field }
              : { op: 'set', doc: op.doc, field: op.field, value: old },
          );
          break;
        }
        case 'unset': {
          const old = parentState.get(op.doc)?.[op.field];
          inverse.push({ op: 'set', doc: op.doc, field: op.field, value: old });
          break;
        }
        case 'delete': {
          const old = parentState.get(op.doc) || {};
          inverse.push({ op: 'restore', doc: op.doc, fields: old });
          break;
        }
        case 'restore': {
          inverse.push({ op: 'delete', doc: op.doc });
          break;
        }
        default:
          throw new StoreError('E_VERSION', `cannot invert op: ${op.op}`);
      }
    }
    return this.commit({
      branch,
      ops: inverse,
      lamport,
      message: message || `undo ${version}`,
    });
  }

  // --- phrase index --------------------------------------------------------

  // Incremental append: one posting per touched doc per version.
  // Deletes are versioned tombstone postings; nothing is rewritten in place.
  _indexVersion(v) {
    const touched = [...new Set(v.ops.map((o) => o.doc))];
    if (touched.length === 0) return;
    const state = this._materializeSet(this.ancestors(v.id));
    const segment = [];
    for (const doc of touched.sort()) {
      const fields = state.get(doc);
      if (fields) segment.push({ doc, version: v.id, text: docText(fields) });
      else segment.push({ doc, version: v.id, tombstone: true });
    }
    this.segments.push(segment);
  }

  _visiblePostings(visibleSet) {
    const out = [];
    for (const seg of this.segments) {
      for (const p of seg) if (visibleSet.has(p.version)) out.push(p);
    }
    out.sort((a, b) => {
      const va = this.versions.get(a.version);
      const vb = this.versions.get(b.version);
      return va.lamport - vb.lamport || cmpVersionId(a.version, b.version);
    });
    return out;
  }

  // Phrase query filtered by version visibility: only postings whose version
  // is an ancestor of (or equal to) asOf contribute.
  query(phrase, { asOf }) {
    const visible = this.ancestors(asOf);
    const state = new Map(); // doc -> text
    for (const p of this._visiblePostings(visible)) {
      if (p.tombstone) state.delete(p.doc);
      else state.set(p.doc, p.text);
    }
    return [...state.entries()]
      .filter(([, text]) => text.includes(phrase))
      .map(([doc]) => doc)
      .sort();
  }

  // Merge all segments into one sorted, deduplicated segment. Every versioned
  // posting is preserved, so any as_of query yields identical results.
  compact() {
    const seen = new Set();
    const merged = [];
    for (const seg of this.segments) {
      for (const p of seg) {
        const key = JSON.stringify(p);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(p);
        }
      }
    }
    merged.sort((a, b) => {
      const va = this.versions.get(a.version);
      const vb = this.versions.get(b.version);
      return va.lamport - vb.lamport || cmpVersionId(a.version, b.version) || (a.doc < b.doc ? -1 : 1);
    });
    this.segments = [merged];
    return merged.length;
  }

  // --- persistence ---------------------------------------------------------

  toJSON() {
    return {
      counter: this.counter,
      clock: this.clock,
      versions: [...this.versions.values()],
      branches: [...this.branches.entries()],
      segments: this.segments,
    };
  }

  static fromJSON(data) {
    const s = new Store();
    s.counter = data.counter;
    s.clock = data.clock;
    for (const v of data.versions) s.versions.set(v.id, v);
    for (const [name, head] of data.branches) s.branches.set(name, head);
    s.segments = data.segments;
    return s;
  }
}

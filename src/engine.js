'use strict';

const { createHash } = require('crypto');
const { parse, evaluate, extractDeps, FormulaSyntaxError } = require('./formula');

class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandError';
    this.code = 'COMMAND_ERROR';
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function tarjanSCC(nodes, depsFn) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;
  const roots = [...nodes].sort();
  for (const root of roots) {
    if (index.has(root)) continue;
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    const work = [{ node: root, children: depsFn(root).slice().sort(), childIndex: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex];
        frame.childIndex += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, children: depsFn(child).slice().sort(), childIndex: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(child)));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1];
          low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          const scc = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.node);
          scc.sort();
          sccs.push(scc);
        }
      }
    }
  }
  return sccs;
}

function planOrder(nodes, depsFn) {
  const sccs = tarjanSCC(nodes, depsFn);
  const sccOf = new Map();
  sccs.forEach((scc, i) => scc.forEach((n) => sccOf.set(n, i)));
  const indegree = sccs.map(() => 0);
  const dependents = sccs.map(() => new Set());
  sccs.forEach((scc, i) => {
    const deps = new Set();
    for (const n of scc) {
      for (const d of depsFn(n)) {
        const j = sccOf.get(d);
        if (j !== undefined && j !== i) deps.add(j);
      }
    }
    indegree[i] = deps.size;
    for (const j of deps) dependents[j].add(i);
  });
  const ready = [];
  for (let i = 0; i < sccs.length; i += 1) if (indegree[i] === 0) ready.push(i);
  const order = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (sccs[a][0] < sccs[b][0] ? -1 : 1));
    const i = ready.shift();
    order.push(sccs[i]);
    for (const j of dependents[i]) {
      indegree[j] -= 1;
      if (indegree[j] === 0) ready.push(j);
    }
  }
  return order;
}

class RecipeEngine {
  constructor() {
    this.tags = new Map();
    this.values = new Map();
    this.invalid = new Map();
    this.dependents = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;
    this.committed = false;
    this.lastRecomputed = [];
  }

  _depsOf(name) {
    const t = this.tags.get(name);
    if (!t || t.kind !== 'formula') return [];
    return t.deps.filter((d) => this.tags.has(d));
  }

  _withDescendants(names) {
    const seen = new Set();
    const queue = [];
    for (const n of names) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
    while (queue.length > 0) {
      const cur = queue.shift();
      const ds = this.dependents.get(cur);
      if (ds) {
        for (const d of ds) {
          if (!seen.has(d)) {
            seen.add(d);
            queue.push(d);
          }
        }
      }
    }
    return seen;
  }

  _setValue(name, v) {
    this.values.set(name, v);
    this.invalid.delete(name);
  }

  _setInvalid(name, reason) {
    this.invalid.set(name, reason);
    this.values.set(name, null);
  }

  _recompute(affected) {
    const nodes = [...affected].filter((n) => this.tags.has(n));
    const plan = planOrder(nodes, (n) => this._depsOf(n).filter((d) => affected.has(d)));
    const recomputed = [];
    for (const scc of plan) {
      if (scc.length > 1 || this._depsOf(scc[0]).includes(scc[0])) {
        for (const n of scc) {
          this._setInvalid(n, 'cycle');
          recomputed.push(n);
        }
        continue;
      }
      const name = scc[0];
      const tag = this.tags.get(name);
      recomputed.push(name);
      if (tag.kind === 'const') {
        this._setValue(name, tag.value);
        continue;
      }
      const unknown = tag.deps.filter((d) => !this.tags.has(d));
      if (unknown.length > 0) {
        this._setInvalid(name, 'unknown-dependency');
        continue;
      }
      let upstreamInvalid = false;
      for (const d of tag.deps) {
        if (this.invalid.has(d)) {
          upstreamInvalid = true;
          break;
        }
      }
      if (upstreamInvalid) {
        this._setInvalid(name, 'invalid-upstream');
        continue;
      }
      try {
        const v = evaluate(tag.ast, (n) => this.values.get(n));
        if (!Number.isFinite(v)) this._setInvalid(name, 'non-finite-result');
        else this._setValue(name, v);
      } catch (e) {
        if (e && e.code === 'DIVISION_BY_ZERO') this._setInvalid(name, 'division-by-zero');
        else if (e && e.code === 'UNKNOWN_REFERENCE') this._setInvalid(name, 'unknown-dependency');
        else throw e;
      }
    }
    recomputed.sort();
    this.lastRecomputed = recomputed;
  }

  _topoOrderAll() {
    return planOrder([...this.tags.keys()], (n) => this._depsOf(n)).flat();
  }

  _serializeTags() {
    const out = [];
    for (const [name, t] of this.tags) {
      if (t.kind === 'const') out.push([name, { kind: 'const', value: t.value }]);
      else out.push([name, { kind: 'formula', expr: t.expr }]);
    }
    return out;
  }

  _restore(snapshot) {
    this.tags = new Map();
    this.dependents = new Map();
    for (const [name, def] of snapshot) {
      if (def.kind === 'const') {
        this.tags.set(name, { kind: 'const', value: def.value });
      } else {
        const ast = parse(def.expr);
        this.tags.set(name, { kind: 'formula', expr: def.expr, ast, deps: [...extractDeps(ast)].sort() });
      }
    }
    for (const [name, t] of this.tags) {
      if (t.kind !== 'formula') continue;
      for (const d of t.deps) {
        let s = this.dependents.get(d);
        if (!s) {
          s = new Set();
          this.dependents.set(d, s);
        }
        s.add(name);
      }
    }
    this.values = new Map();
    this.invalid = new Map();
    this._recompute(new Set(this.tags.keys()));
  }

  _pushUndo() {
    this.undoStack.push(this._serializeTags());
    this.redoStack = [];
  }

  _upsert(name, def) {
    const old = this.tags.get(name);
    if (old && old.kind === 'formula') {
      for (const d of old.deps) {
        const s = this.dependents.get(d);
        if (s) s.delete(name);
      }
    }
    this.tags.set(name, def);
    if (def.kind === 'formula') {
      for (const d of def.deps) {
        let s = this.dependents.get(d);
        if (!s) {
          s = new Set();
          this.dependents.set(d, s);
        }
        s.add(name);
      }
    }
    this._recompute(this._withDescendants([name]));
  }

  _remove(name) {
    const tag = this.tags.get(name);
    const affected = this._withDescendants([name]);
    affected.delete(name);
    if (tag.kind === 'formula') {
      for (const d of tag.deps) {
        const s = this.dependents.get(d);
        if (s) s.delete(name);
      }
    }
    this.tags.delete(name);
    this.values.delete(name);
    this.invalid.delete(name);
    this._recompute(affected);
  }

  _capture() {
    return {
      tagNames: new Set(this.tags.keys()),
      values: new Map(this.values),
      invalid: new Map(this.invalid),
    };
  }

  _diff(before, after) {
    const added = [...after.tagNames].filter((n) => !before.tagNames.has(n)).sort();
    const removed = [...before.tagNames].filter((n) => !after.tagNames.has(n)).sort();
    const changed = {};
    for (const n of [...after.tagNames].sort()) {
      if (!before.tagNames.has(n)) continue;
      if (before.invalid.has(n) !== after.invalid.has(n)) continue;
      const bv = before.invalid.has(n) ? null : before.values.get(n);
      const av = after.invalid.has(n) ? null : after.values.get(n);
      if (bv !== av) changed[n] = { from: bv === undefined ? null : bv, to: av === undefined ? null : av };
    }
    const invalidated = [...after.invalid.keys()].filter((n) => !before.invalid.has(n)).sort();
    const validated = [...before.invalid.keys()]
      .filter((n) => !after.invalid.has(n) && after.tagNames.has(n))
      .sort();
    return { added, removed, changed, invalidated, validated };
  }

  _stateViews() {
    const values = {};
    for (const n of [...this.tags.keys()].sort()) {
      values[n] = this.invalid.has(n) ? null : this.values.get(n);
    }
    const invalid = {};
    for (const n of [...this.invalid.keys()].sort()) invalid[n] = this.invalid.get(n);
    return { values, invalid };
  }

  _certificate() {
    const { values } = this._stateViews();
    return {
      seq: this.version,
      topo: this._topoOrderAll(),
      hashAlgorithm: 'sha256',
      hash: createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex'),
    };
  }

  _apply(cmd) {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      throw new CommandError('command must be an object');
    }
    const op = cmd.op;
    if (op === 'upsert') {
      const name = validName(cmd.name);
      if (cmd.type === 'const') {
        if (typeof cmd.value !== 'number' || !Number.isFinite(cmd.value)) {
          throw new CommandError(`upsert ${name}: "value" must be a finite number`);
        }
        this._pushUndo();
        this._upsert(name, { kind: 'const', value: cmd.value });
        return null;
      }
      if (cmd.type === 'formula') {
        const expr = cmd.expr !== undefined ? cmd.expr : cmd.expression;
        if (typeof expr !== 'string' || expr.trim() === '') {
          throw new CommandError(`upsert ${name}: "expr" must be a non-empty string`);
        }
        let ast;
        try {
          ast = parse(expr);
        } catch (e) {
          if (e instanceof FormulaSyntaxError) {
            throw new CommandError(`upsert ${name}: invalid formula: ${e.message}`);
          }
          throw e;
        }
        this._pushUndo();
        this._upsert(name, { kind: 'formula', expr, ast, deps: [...extractDeps(ast)].sort() });
        return null;
      }
      throw new CommandError(`upsert ${name}: "type" must be "const" or "formula"`);
    }
    if (op === 'set') {
      const name = validName(cmd.name);
      if (typeof cmd.value !== 'number' || !Number.isFinite(cmd.value)) {
        throw new CommandError(`set ${name}: "value" must be a finite number`);
      }
      const tag = this.tags.get(name);
      if (tag && tag.kind !== 'const') {
        throw new CommandError(`set ${name}: cannot set a value on a formula tag`);
      }
      this._pushUndo();
      if (tag) {
        tag.value = cmd.value;
        this._recompute(this._withDescendants([name]));
      } else {
        this._upsert(name, { kind: 'const', value: cmd.value });
      }
      return null;
    }
    if (op === 'remove') {
      const name = validName(cmd.name);
      if (!this.tags.has(name)) return { noop: true };
      this._pushUndo();
      this._remove(name);
      return null;
    }
    if (op === 'undo') {
      if (this.undoStack.length === 0) return { noop: true };
      this.redoStack.push(this._serializeTags());
      this._restore(this.undoStack.pop());
      return null;
    }
    if (op === 'redo') {
      if (this.redoStack.length === 0) return { noop: true };
      this.undoStack.push(this._serializeTags());
      this._restore(this.redoStack.pop());
      return null;
    }
    if (op === 'commit') {
      this.committed = true;
      return null;
    }
    throw new CommandError(`unknown op: ${JSON.stringify(op)}`);
  }

  execute(cmd) {
    this.lastRecomputed = [];
    const before = this._capture();
    this.version += 1;
    let status = 'ok';
    let message;
    try {
      const r = this._apply(cmd);
      if (r && r.noop) status = 'noop';
    } catch (e) {
      if (e instanceof CommandError) {
        status = 'error';
        message = e.message;
      } else {
        throw e;
      }
    }
    const views = this._stateViews();
    const entry = {
      version: this.version,
      command: cmd === undefined ? null : cmd,
      status,
      committed: this.committed,
      diff: this._diff(before, this._capture()),
      recomputed: this.lastRecomputed,
      values: views.values,
      invalid: views.invalid,
      certificate: this._certificate(),
    };
    if (message) entry.message = message;
    return entry;
  }

  finalState() {
    const views = this._stateViews();
    return {
      version: this.version,
      committed: this.committed,
      values: views.values,
      invalid: views.invalid,
      certificate: this._certificate(),
    };
  }
}

function validName(n) {
  if (typeof n !== 'string' || !NAME_RE.test(n)) {
    throw new CommandError(`invalid tag name: ${JSON.stringify(n)}`);
  }
  return n;
}

module.exports = { RecipeEngine, CommandError, canonicalJson };

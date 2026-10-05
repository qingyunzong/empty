'use strict';

const crypto = require('node:crypto');
const { parse, collectDeps, evaluate, FormulaError } = require('./formula');

class CommandError extends Error {
  constructor(message, code = 'E_COMMAND') {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

class Engine {
  constructor() {
    this.tags = new Map(); // name -> {type:'const',value} | {type:'formula',expr,ast,deps:[..]}
    this.values = new Map(); // name -> number (valid tags only)
    this.invalid = new Set(); // names of invalid tags
    this.dependents = new Map(); // dep name -> Set of tag names referencing it
    this.past = []; // undo stack of snapshots
    this.future = []; // redo stack of snapshots
    this.version = 0;
  }

  // ---------- graph helpers ----------

  addDependentEdges(name, deps) {
    for (const dep of deps) {
      if (!this.dependents.has(dep)) this.dependents.set(dep, new Set());
      this.dependents.get(dep).add(name);
    }
  }

  removeDependentEdges(name, deps) {
    for (const dep of deps) {
      const set = this.dependents.get(dep);
      if (set) {
        set.delete(name);
        if (set.size === 0) this.dependents.delete(dep);
      }
    }
  }

  // Kahn's algorithm over `scope` (a Set of tag names) with lexicographic
  // tie-break by tag name. Returns only the acyclic part: nodes that are in a
  // cycle, or reachable only through a cycle, are omitted.
  kahnOrder(scope) {
    const indeg = new Map();
    for (const name of scope) {
      const tag = this.tags.get(name);
      let deg = 0;
      if (tag && tag.type === 'formula') {
        for (const dep of tag.deps) if (scope.has(dep)) deg += 1;
      }
      indeg.set(name, deg);
    }
    const ready = [...scope].filter((n) => indeg.get(n) === 0).sort();
    const order = [];
    while (ready.length > 0) {
      const name = ready.shift();
      order.push(name);
      const outs = this.dependents.get(name);
      if (!outs) continue;
      for (const next of outs) {
        if (!scope.has(next)) continue;
        indeg.set(next, indeg.get(next) - 1);
        if (indeg.get(next) === 0) {
          ready.push(next);
          ready.sort();
        }
      }
    }
    return order;
  }

  // Deterministic topological order of all given tags. Cyclic leftovers are
  // appended in sorted order so the output stays fully deterministic.
  topoOrder(names) {
    const scope = new Set(names);
    const order = this.kahnOrder(scope);
    if (order.length < scope.size) {
      const emitted = new Set(order);
      const leftover = [...scope].filter((n) => !emitted.has(n)).sort();
      order.push(...leftover);
    }
    return order;
  }

  // ---------- evaluation ----------

  evalTag(name) {
    const tag = this.tags.get(name);
    if (tag.type === 'const') {
      this.values.set(name, tag.value);
      this.invalid.delete(name);
      return;
    }
    let bad = false;
    const resolve = (dep) => {
      if (!this.tags.has(dep) || this.invalid.has(dep)) {
        bad = true;
        return 0;
      }
      return this.values.get(dep);
    };
    try {
      const value = evaluate(tag.ast, resolve);
      if (bad || !Number.isFinite(value)) {
        this.markInvalid(name);
      } else {
        this.values.set(name, value);
        this.invalid.delete(name);
      }
    } catch (err) {
      if (err instanceof FormulaError) {
        this.markInvalid(name);
      } else {
        throw err;
      }
    }
  }

  markInvalid(name) {
    this.values.delete(name);
    this.invalid.add(name);
  }

  // Recompute only tags reachable downstream from `changed`.
  // Returns the sorted list of affected (recomputed/invalidated) tag names.
  recompute(changed) {
    const affected = new Set();
    const stack = [...changed];
    while (stack.length > 0) {
      const name = stack.pop();
      if (!this.tags.has(name) || affected.has(name)) continue;
      affected.add(name);
      const outs = this.dependents.get(name);
      if (outs) for (const next of outs) stack.push(next);
    }
    const order = this.kahnOrder(affected);
    const emitted = new Set(order);
    for (const name of order) this.evalTag(name);
    for (const name of affected) {
      if (!emitted.has(name)) this.markInvalid(name); // in/under a cycle
    }
    return [...affected].sort();
  }

  // ---------- snapshots / undo ----------

  snapshot() {
    const tags = {};
    for (const [name, tag] of this.tags) {
      tags[name] = tag.type === 'const'
        ? { type: 'const', value: tag.value }
        : { type: 'formula', expr: tag.expr };
    }
    const values = {};
    for (const [name, value] of this.values) values[name] = value;
    return { tags, values, invalid: [...this.invalid] };
  }

  restore(snap) {
    this.tags = new Map();
    this.dependents = new Map();
    for (const [name, tag] of Object.entries(snap.tags)) {
      if (tag.type === 'const') {
        this.tags.set(name, { type: 'const', value: tag.value });
      } else {
        const ast = parse(tag.expr);
        const deps = [...collectDeps(ast)].sort();
        this.tags.set(name, { type: 'formula', expr: tag.expr, ast, deps });
        this.addDependentEdges(name, deps);
      }
    }
    this.values = new Map(Object.entries(snap.values));
    this.invalid = new Set(snap.invalid);
  }

  pushHistory() {
    this.past.push(this.snapshot());
    this.future = [];
  }

  // ---------- state inspection ----------

  tagState(name) {
    if (!this.tags.has(name)) return 'absent';
    if (this.invalid.has(name)) return 'invalid';
    return this.values.get(name);
  }

  stateMap() {
    const map = {};
    for (const name of this.tags.keys()) map[name] = this.tagState(name);
    return map;
  }

  diffStates(before, after) {
    const diff = {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = before[name] === undefined ? 'absent' : before[name];
      const to = after[name] === undefined ? 'absent' : after[name];
      if (from !== to) diff[name] = { from, to };
    }
    return diff;
  }

  certificate(seq) {
    const values = {};
    for (const [name, value] of this.values) values[name] = value;
    const invalid = [...this.invalid].sort();
    const payload = { invalid, values };
    return {
      seq,
      topo: this.topoOrder([...this.tags.keys()]),
      hash: sha256(canonicalJson(payload)),
    };
  }

  // ---------- commands ----------

  execute(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.op !== 'string') {
      throw new CommandError('command must be an object with an "op" field');
    }
    const before = this.stateMap();
    let recomputed = [];
    switch (cmd.op) {
      case 'upsert':
        recomputed = this.cmdUpsert(cmd);
        break;
      case 'set':
        recomputed = this.cmdSet(cmd);
        break;
      case 'remove':
        recomputed = this.cmdRemove(cmd);
        break;
      case 'undo':
        this.cmdUndo();
        break;
      case 'redo':
        this.cmdRedo();
        break;
      case 'commit':
        break; // checkpoint: no state change
      default:
        throw new CommandError(`unknown op: ${cmd.op}`);
    }
    this.version += 1;
    const after = this.stateMap();
    return {
      version: this.version,
      diff: this.diffStates(before, after),
      recomputed,
      certificate: this.certificate(this.version),
    };
  }

  cmdUpsert(cmd) {
    if (typeof cmd.tag !== 'string' || cmd.tag === '') {
      throw new CommandError('upsert requires a non-empty "tag" string');
    }
    let def;
    if (cmd.type === 'const') {
      if (typeof cmd.value !== 'number' || !Number.isFinite(cmd.value)) {
        throw new CommandError(`const tag ${cmd.tag} requires a finite numeric "value"`);
      }
      def = { type: 'const', value: cmd.value };
    } else if (cmd.type === 'formula') {
      let ast;
      try {
        ast = parse(cmd.expr);
      } catch (err) {
        if (err instanceof FormulaError) throw new CommandError(err.message, err.code);
        throw err;
      }
      const deps = [...collectDeps(ast)].sort();
      def = { type: 'formula', expr: cmd.expr, ast, deps };
    } else {
      throw new CommandError('upsert requires "type" to be "const" or "formula"');
    }
    this.pushHistory();
    const old = this.tags.get(cmd.tag);
    if (old && old.type === 'formula') this.removeDependentEdges(cmd.tag, old.deps);
    this.tags.set(cmd.tag, def);
    if (def.type === 'formula') this.addDependentEdges(cmd.tag, def.deps);
    return this.recompute([cmd.tag]);
  }

  cmdSet(cmd) {
    if (typeof cmd.tag !== 'string' || cmd.tag === '') {
      throw new CommandError('set requires a non-empty "tag" string');
    }
    if (typeof cmd.value !== 'number' || !Number.isFinite(cmd.value)) {
      throw new CommandError(`set ${cmd.tag} requires a finite numeric "value"`);
    }
    const old = this.tags.get(cmd.tag);
    if (old && old.type !== 'const') {
      throw new CommandError(`cannot set formula tag ${cmd.tag}; use upsert to change its expression`);
    }
    this.pushHistory();
    if (old) {
      old.value = cmd.value;
    } else {
      this.tags.set(cmd.tag, { type: 'const', value: cmd.value });
    }
    return this.recompute([cmd.tag]);
  }

  cmdRemove(cmd) {
    if (typeof cmd.tag !== 'string' || cmd.tag === '') {
      throw new CommandError('remove requires a non-empty "tag" string');
    }
    const old = this.tags.get(cmd.tag);
    if (!old) return []; // idempotent no-op
    this.pushHistory();
    const downstream = [...(this.dependents.get(cmd.tag) || [])];
    if (old.type === 'formula') this.removeDependentEdges(cmd.tag, old.deps);
    this.tags.delete(cmd.tag);
    this.values.delete(cmd.tag);
    this.invalid.delete(cmd.tag);
    return this.recompute(downstream);
  }

  cmdUndo() {
    if (this.past.length === 0) return;
    this.future.push(this.snapshot());
    this.restore(this.past.pop());
  }

  cmdRedo() {
    if (this.future.length === 0) return;
    this.past.push(this.snapshot());
    this.restore(this.future.pop());
  }
}

module.exports = { Engine, CommandError, canonicalJson, sha256 };

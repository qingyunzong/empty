'use strict';

const { stableHash } = require('./canonical');

function compareArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// Independent brute-force reference model. It derives everything directly
// from the raw event log with plain DFS scans and shares no graph-index
// code with Genealogy, so tests can cross-check the optimized library
// against exhaustive path enumeration.
class ReferenceModel {
  constructor() {
    this.events = new Map();
    this.flags = new Map();
    this.version = 0;
  }

  _flag(name) {
    if (!this.flags.has(name)) this.flags.set(name, { held: false, shipped: false });
    return this.flags.get(name);
  }

  append(event) {
    this.events.set(event.id, { id: event.id, output: event.output, inputs: [...event.inputs] });
    this.flags.set(event.output, { held: false, shipped: false });
    this.version += 1;
  }

  correct(eventId, patch) {
    const old = this.events.get(eventId);
    const output = patch.output === undefined ? old.output : patch.output;
    const inputs = patch.inputs === undefined ? old.inputs : patch.inputs;
    if (output !== old.output) {
      const f = this.flags.get(old.output);
      this.flags.delete(old.output);
      if (f) this.flags.set(output, f);
    }
    this.events.set(eventId, { id: eventId, output, inputs: [...inputs] });
    this._flag(output);
    this.version += 1;
  }

  undo(eventId) {
    const ev = this.events.get(eventId);
    this.events.delete(eventId);
    if (ev) this.flags.delete(ev.output);
    this.version += 1;
  }

  hold(name) {
    this._flag(name).held = true;
    this.version += 1;
  }

  release(name) {
    this._flag(name).held = false;
    this.version += 1;
  }

  ship(name) {
    this._flag(name).shipped = true;
    this.version += 1;
  }

  batches() {
    const out = new Set();
    for (const e of this.events.values()) out.add(e.output);
    return [...out].sort();
  }

  parentsOf(name) {
    const out = [];
    for (const e of this.events.values()) if (e.output === name) out.push(...e.inputs);
    return out;
  }

  childrenOf(name) {
    const out = [];
    for (const e of this.events.values()) if (e.inputs.includes(name)) out.push(e.output);
    return out;
  }

  ancestorsOf(name) {
    const seen = new Set();
    const stack = this.parentsOf(name);
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.parentsOf(cur));
    }
    return seen;
  }

  blockers(name) {
    const out = [];
    if (this._flag(name).held) out.push(name);
    for (const a of this.ancestorsOf(name)) if (this._flag(a).held) out.push(a);
    return out.sort();
  }

  status(name) {
    if (this._flag(name).shipped) return 'shipped';
    return this.blockers(name).length > 0 ? 'held' : 'released';
  }

  allPaths(src, dst) {
    const paths = [];
    const visit = (cur, path) => {
      if (cur === dst) {
        paths.push(path);
        return;
      }
      for (const next of this.childrenOf(cur)) {
        if (path.includes(next)) continue;
        visit(next, [...path, next]);
      }
    };
    visit(src, [src]);
    return paths;
  }

  certificate(target) {
    const sources = this.blockers(target);
    const paths = [];
    for (const s of sources) for (const p of this.allPaths(s, target)) paths.push(p);
    paths.sort(compareArrays);
    const body = {
      batch: target,
      version: this.version,
      status: this.status(target),
      riskSources: sources,
      paths,
    };
    return { ...body, hash: stableHash(body) };
  }
}

module.exports = { ReferenceModel, compareArrays };

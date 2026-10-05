'use strict';

const { stableHash } = require('./canonical');

class GenealogyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GenealogyError';
    this.code = code;
  }
}

function compareArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

class Genealogy {
  constructor() {
    this.events = new Map(); // event id -> { id, output, inputs[] }
    this.batches = new Map(); // batch name -> { held, shipped }
    this.parents = new Map(); // batch name -> Set of input batches
    this.children = new Map(); // batch name -> Set of downstream batches
    this.version = 0;
  }

  _ensureBatch(name) {
    if (!this.batches.has(name)) {
      this.batches.set(name, { held: false, shipped: false });
      this.parents.set(name, new Set());
      this.children.set(name, new Set());
    }
  }

  _requireBatch(name) {
    const rec = this.batches.get(name);
    if (!rec) throw new GenealogyError('UNKNOWN_BATCH', `unknown batch: ${name}`);
    return rec;
  }

  _referencedAsInput(name) {
    for (const ev of this.events.values()) {
      if (ev.inputs.includes(name)) return true;
    }
    return false;
  }

  _addEdges(ev) {
    for (const input of ev.inputs) {
      this.parents.get(ev.output).add(input);
      this.children.get(input).add(ev.output);
    }
  }

  _removeEdges(ev) {
    for (const input of ev.inputs) {
      this.parents.get(ev.output).delete(input);
      this.children.get(input).delete(ev.output);
    }
  }

  _ancestors(name) {
    const seen = new Set();
    const stack = [...this.parents.get(name)];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.parents.get(cur)) stack.push(p);
    }
    return seen;
  }

  _descendants(name) {
    const seen = new Set();
    const stack = [...this.children.get(name)];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const c of this.children.get(cur)) stack.push(c);
    }
    return [...seen].sort();
  }

  _blockers(name) {
    const out = [];
    const rec = this.batches.get(name);
    if (rec && rec.held) out.push(name);
    for (const ancestor of this._ancestors(name)) {
      const r = this.batches.get(ancestor);
      if (r && r.held) out.push(ancestor);
    }
    return out.sort();
  }

  _statusOf(name) {
    const rec = this.batches.get(name);
    if (!rec) return null;
    if (rec.shipped) return 'shipped';
    return this._blockers(name).length > 0 ? 'held' : 'released';
  }

  _snapshotBatch(name) {
    const rec = this.batches.get(name);
    if (!rec) return null;
    return {
      status: this._statusOf(name),
      blockers: this._blockers(name),
      manualHold: rec.held,
      shipped: rec.shipped,
    };
  }

  _snapshots(names) {
    const map = new Map();
    for (const n of new Set(names)) {
      if (this.batches.has(n)) map.set(n, this._snapshotBatch(n));
    }
    return map;
  }

  _statusDiff(before, after) {
    const changes = [];
    const keys = new Set([...before.keys(), ...after.keys()]);
    for (const key of [...keys].sort()) {
      const b = before.has(key) ? before.get(key) : null;
      const a = after.has(key) ? after.get(key) : null;
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        changes.push({ batch: key, from: b, to: a });
      }
    }
    return changes;
  }

  _assertAcyclic(output, inputs) {
    for (const input of inputs) {
      if (input === output) {
        throw new GenealogyError('CYCLE', `cycle detected: batch ${output} would become its own ancestor`);
      }
      if (this._ancestors(input).has(output)) {
        throw new GenealogyError('CYCLE', `cycle detected: ${output} is already an ancestor of ${input}`);
      }
    }
  }

  _validateEventShape(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new GenealogyError('INVALID_EVENT', 'event must be an object');
    }
    const { id, output } = event;
    const inputs = event.inputs === undefined ? [] : event.inputs;
    if (!isNonEmptyString(id)) {
      throw new GenealogyError('INVALID_EVENT', 'event.id must be a non-empty string');
    }
    if (!isNonEmptyString(output)) {
      throw new GenealogyError('INVALID_EVENT', 'event.output must be a non-empty string');
    }
    if (!Array.isArray(inputs) || inputs.some((i) => !isNonEmptyString(i))) {
      throw new GenealogyError('INVALID_EVENT', 'event.inputs must be an array of non-empty strings');
    }
    if (new Set(inputs).size !== inputs.length) {
      throw new GenealogyError('INVALID_EVENT', `event ${id} has duplicate inputs`);
    }
    return { id, output, inputs: [...inputs] };
  }

  appendEvent(event) {
    const { id, output, inputs } = this._validateEventShape(event);
    if (this.events.has(id)) {
      throw new GenealogyError('DUPLICATE_EVENT', `duplicate event id: ${id}`);
    }
    if (this.batches.has(output)) {
      throw new GenealogyError('DUPLICATE_OUTPUT', `duplicate output batch: ${output}`);
    }
    for (const input of inputs) {
      if (!this.batches.has(input)) {
        throw new GenealogyError('UNKNOWN_BATCH', `unknown parent batch: ${input}`);
      }
    }
    this._assertAcyclic(output, inputs);
    this._ensureBatch(output);
    const ev = { id, output, inputs };
    this.events.set(id, ev);
    this._addEdges(ev);
    this.version += 1;
    const after = this._snapshots([output, ...this._descendants(output)]);
    return {
      op: 'append',
      eventId: id,
      version: this.version,
      diff: {
        edges: { added: inputs.map((i) => [i, output]).sort(compareArrays), removed: [] },
        statusChanges: this._statusDiff(new Map(), after),
      },
    };
  }

  correctEvent(eventId, patch) {
    const old = this.events.get(eventId);
    if (!old) throw new GenealogyError('UNKNOWN_EVENT', `unknown event: ${eventId}`);
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.id !== undefined && p.id !== eventId) {
      throw new GenealogyError('INVALID_EVENT', 'event id is immutable');
    }
    const candidate = this._validateEventShape({
      id: eventId,
      output: p.output === undefined ? old.output : p.output,
      inputs: p.inputs === undefined ? old.inputs : p.inputs,
    });
    const renamed = candidate.output !== old.output;
    if (renamed) {
      if (this.batches.has(candidate.output)) {
        throw new GenealogyError('DUPLICATE_OUTPUT', `duplicate output batch: ${candidate.output}`);
      }
      if (this._referencedAsInput(old.output)) {
        throw new GenealogyError('OUTPUT_REFERENCED', `cannot rename ${old.output}: batch is referenced as an input`);
      }
    }
    for (const input of candidate.inputs) {
      if (!this.batches.has(input) || (renamed && input === old.output)) {
        throw new GenealogyError('UNKNOWN_BATCH', `unknown parent batch: ${input}`);
      }
    }
    const before = this._snapshots([old.output, ...this._descendants(old.output)]);
    this._removeEdges(old);
    try {
      this._assertAcyclic(candidate.output, candidate.inputs);
    } catch (err) {
      this._addEdges(old);
      throw err;
    }
    const removedEdges = old.inputs
      .filter((i) => renamed || !candidate.inputs.includes(i))
      .map((i) => [i, old.output]);
    const addedEdges = candidate.inputs
      .filter((i) => renamed || !old.inputs.includes(i))
      .map((i) => [i, candidate.output]);
    if (renamed) {
      const rec = this.batches.get(old.output);
      this.batches.delete(old.output);
      this.parents.delete(old.output);
      this.children.delete(old.output);
      this.batches.set(candidate.output, rec);
      this.parents.set(candidate.output, new Set());
      this.children.set(candidate.output, new Set());
    }
    const ev = { id: eventId, output: candidate.output, inputs: candidate.inputs };
    this.events.set(eventId, ev);
    this._addEdges(ev);
    this.version += 1;
    const after = this._snapshots([candidate.output, ...this._descendants(candidate.output)]);
    return {
      op: 'correct',
      eventId,
      version: this.version,
      diff: {
        edges: { added: addedEdges.sort(compareArrays), removed: removedEdges.sort(compareArrays) },
        statusChanges: this._statusDiff(before, after),
      },
    };
  }

  undoEvent(eventId) {
    const ev = this.events.get(eventId);
    if (!ev) throw new GenealogyError('UNKNOWN_EVENT', `unknown event: ${eventId}`);
    if (this._referencedAsInput(ev.output)) {
      throw new GenealogyError(
        'OUTPUT_REFERENCED',
        `cannot undo ${eventId}: batch ${ev.output} is referenced as an input`,
      );
    }
    const before = this._snapshots([ev.output, ...this._descendants(ev.output)]);
    this._removeEdges(ev);
    this.events.delete(eventId);
    this.batches.delete(ev.output);
    this.parents.delete(ev.output);
    this.children.delete(ev.output);
    this.version += 1;
    return {
      op: 'undo',
      eventId,
      version: this.version,
      diff: {
        edges: { added: [], removed: ev.inputs.map((i) => [i, ev.output]).sort(compareArrays) },
        statusChanges: this._statusDiff(before, new Map()),
      },
    };
  }

  _setHold(batch, value, op) {
    const rec = this._requireBatch(batch);
    const names = [batch, ...this._descendants(batch)];
    const before = this._snapshots(names);
    rec.held = value;
    this.version += 1;
    const after = this._snapshots(names);
    return {
      op,
      batch,
      version: this.version,
      diff: { edges: { added: [], removed: [] }, statusChanges: this._statusDiff(before, after) },
    };
  }

  hold(batch) {
    return this._setHold(batch, true, 'hold');
  }

  release(batch) {
    return this._setHold(batch, false, 'release');
  }

  ship(batch) {
    const rec = this._requireBatch(batch);
    const before = this._snapshots([batch]);
    rec.shipped = true;
    this.version += 1;
    const after = this._snapshots([batch]);
    return {
      op: 'ship',
      batch,
      version: this.version,
      diff: { edges: { added: [], removed: [] }, statusChanges: this._statusDiff(before, after) },
    };
  }

  _allPaths(src, dst) {
    const paths = [];
    const stack = [[src]];
    while (stack.length > 0) {
      const path = stack.pop();
      const last = path[path.length - 1];
      if (last === dst) {
        paths.push(path);
        continue;
      }
      const next = [...this.children.get(last)].sort().reverse();
      for (const c of next) {
        if (path.includes(c)) continue;
        stack.push([...path, c]);
      }
    }
    return paths;
  }

  certificate(target) {
    this._requireBatch(target);
    const sources = this._blockers(target);
    const paths = [];
    for (const s of sources) {
      for (const p of this._allPaths(s, target)) paths.push(p);
    }
    paths.sort(compareArrays);
    const body = {
      batch: target,
      version: this.version,
      status: this._statusOf(target),
      riskSources: sources,
      paths,
    };
    return { ...body, hash: stableHash(body) };
  }

  query(batch) {
    if (batch === undefined || batch === null) {
      return {
        op: 'query',
        version: this.version,
        batches: [...this.batches.keys()]
          .sort()
          .map((name) => ({ batch: name, ...this._snapshotBatch(name) })),
      };
    }
    this._requireBatch(batch);
    const blockers = this._blockers(batch);
    const reasons = blockers.map((s) => ({ source: s, kind: s === batch ? 'self' : 'ancestor' }));
    return {
      op: 'query',
      batch,
      version: this.version,
      ...this._snapshotBatch(batch),
      reasons,
      certificate: this.certificate(batch),
    };
  }

  snapshot() {
    const batches = {};
    for (const name of [...this.batches.keys()].sort()) {
      batches[name] = this._snapshotBatch(name);
    }
    const events = [...this.events.values()]
      .map((e) => ({ id: e.id, output: e.output, inputs: [...e.inputs] }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const edges = [];
    for (const e of this.events.values()) {
      for (const i of e.inputs) edges.push([i, e.output]);
    }
    edges.sort(compareArrays);
    return { version: this.version, batches, events, edges };
  }
}

module.exports = { Genealogy, GenealogyError, compareArrays };

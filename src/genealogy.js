'use strict';

class GenealogyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GenealogyError';
    this.code = code;
  }
}

function cloneEvent(event) {
  const copy = Object.assign({}, event);
  if (Array.isArray(event.inputs)) copy.inputs = event.inputs.slice();
  return copy;
}

function cloneJournal(journal) {
  return journal.map(cloneEvent);
}

function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

class Genealogy {
  constructor() {
    this.batches = new Map(); // id -> { kind, held, shipped }
    this.parents = new Map(); // output id -> [input ids]
    this.children = new Map(); // id -> Set of output ids
    this.heldAnc = new Map(); // id -> Set of held ancestor ids (incl. self)
    this.journal = []; // applied mutation events (source of truth)
    this.undoStack = []; // previous journal snapshots
    this.version = 0;
    this.snapshots = [this._summary()];
  }

  _requireBatch(id) {
    if (!this.batches.has(id)) {
      throw new GenealogyError('UNKNOWN_BATCH', `unknown batch: ${id}`);
    }
  }

  define(id, kind = 'input') {
    return this._mutate({ op: 'define', batch: id, kind });
  }

  transform(output, inputs) {
    return this._mutate({ op: 'transform', output, inputs: inputs.slice() });
  }

  hold(id) {
    return this._mutate({ op: 'hold', batch: id });
  }

  release(id) {
    return this._mutate({ op: 'release', batch: id });
  }

  ship(id) {
    return this._mutate({ op: 'ship', batch: id });
  }

  correct(index, event) {
    if (!Number.isInteger(index) || index < 0 || index >= this.journal.length) {
      throw new GenealogyError(
        'BAD_INDEX',
        `correct: journal index ${index} out of range (journal length ${this.journal.length})`,
      );
    }
    const next = cloneEvent(event);
    this.undoStack.push(cloneJournal(this.journal));
    try {
      this.journal[index] = next;
      this._rebuild();
    } catch (err) {
      this.journal = this.undoStack.pop();
      this._rebuild();
      throw err;
    }
    return this._commit();
  }

  undo() {
    if (this.undoStack.length === 0) {
      throw new GenealogyError('NOTHING_TO_UNDO', 'undo: no mutation to undo');
    }
    this.journal = this.undoStack.pop();
    this._rebuild();
    return this._commit();
  }

  query(id) {
    this._requireBatch(id);
    const reasons = [...this.heldAnc.get(id)].sort();
    const paths = [];
    for (const source of reasons) {
      for (const path of this._enumeratePaths(source, id)) paths.push(path);
    }
    paths.sort(comparePaths);
    return {
      batch: id,
      version: this.version,
      status: this._status(id),
      blocked: this._status(id) === 'held',
      shipped: this.batches.get(id).shipped,
      blockReasons: reasons,
      paths,
    };
  }

  _mutate(event) {
    this.undoStack.push(cloneJournal(this.journal));
    try {
      this._apply(event);
    } catch (err) {
      this.undoStack.pop();
      throw err;
    }
    this.journal.push(event);
    return this._commit();
  }

  _apply(event) {
    switch (event.op) {
      case 'define': {
        const id = event.batch;
        if (this.batches.has(id)) {
          throw new GenealogyError('DUPLICATE_BATCH', `duplicate batch definition: ${id}`);
        }
        this.batches.set(id, { kind: event.kind || 'input', held: false, shipped: false });
        this.children.set(id, new Set());
        this.heldAnc.set(id, new Set());
        return;
      }
      case 'transform': {
        const { output, inputs } = event;
        this._requireBatch(output);
        if (this.parents.has(output)) {
          throw new GenealogyError('DUPLICATE_OUTPUT', `duplicate output definition: ${output}`);
        }
        for (const input of inputs) this._requireBatch(input);
        for (const input of inputs) {
          if (input === output || this._reachable(output, input)) {
            throw new GenealogyError(
              'CYCLE',
              `cycle detected: transform ${output} <- ${input} closes a loop`,
            );
          }
        }
        this.batches.get(output).kind = 'output';
        this.parents.set(output, inputs.slice());
        for (const input of inputs) this.children.get(input).add(output);
        this._recomputeCone([output]);
        return;
      }
      case 'hold': {
        this._requireBatch(event.batch);
        const batch = this.batches.get(event.batch);
        if (!batch.held) {
          batch.held = true;
          this._recomputeCone([event.batch]);
        }
        return;
      }
      case 'release': {
        this._requireBatch(event.batch);
        const batch = this.batches.get(event.batch);
        if (batch.held) {
          batch.held = false;
          this._recomputeCone([event.batch]);
        }
        return;
      }
      case 'ship': {
        this._requireBatch(event.batch);
        this.batches.get(event.batch).shipped = true;
        return;
      }
      default:
        throw new GenealogyError('UNKNOWN_OP', `unknown operation: ${event.op}`);
    }
  }

  _reachable(from, to) {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of this.children.get(node)) {
        if (child === to) return true;
        if (!seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    return false;
  }

  _recomputeCone(startIds) {
    const cone = new Set(startIds);
    const stack = [...startIds];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of this.children.get(node)) {
        if (!cone.has(child)) {
          cone.add(child);
          stack.push(child);
        }
      }
    }
    const indegree = new Map();
    for (const node of cone) {
      let degree = 0;
      for (const parent of this.parents.get(node) || []) {
        if (cone.has(parent)) degree += 1;
      }
      indegree.set(node, degree);
    }
    const queue = [...cone].filter((node) => indegree.get(node) === 0);
    while (queue.length > 0) {
      const node = queue.shift();
      const batch = this.batches.get(node);
      const acc = new Set();
      if (batch.held) acc.add(node);
      for (const parent of this.parents.get(node) || []) {
        for (const held of this.heldAnc.get(parent)) acc.add(held);
      }
      this.heldAnc.set(node, acc);
      for (const child of this.children.get(node)) {
        if (!cone.has(child)) continue;
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) queue.push(child);
      }
    }
  }

  _enumeratePaths(source, target) {
    const paths = [];
    const walk = (node, trail) => {
      if (node === target) {
        paths.push(trail.slice());
        return;
      }
      for (const child of [...this.children.get(node)].sort()) {
        trail.push(child);
        walk(child, trail);
        trail.pop();
      }
    };
    walk(source, [source]);
    return paths;
  }

  _status(id) {
    const batch = this.batches.get(id);
    if (batch.shipped) return 'shipped';
    if (this.heldAnc.get(id).size > 0) return 'held';
    return 'released';
  }

  _summary() {
    const batches = {};
    for (const id of [...this.batches.keys()].sort()) {
      const batch = this.batches.get(id);
      batches[id] = {
        kind: batch.kind,
        status: this._status(id),
        held: batch.held,
        shipped: batch.shipped,
        heldAncestors: [...this.heldAnc.get(id)].sort(),
      };
    }
    const edges = {};
    for (const output of [...this.parents.keys()].sort()) {
      edges[output] = this.parents.get(output).slice().sort();
    }
    return { batches, edges };
  }

  _commit() {
    this.version += 1;
    const previous = this.snapshots[this.snapshots.length - 1];
    const next = this._summary();
    this.snapshots.push(next);
    return Genealogy.diff(previous, next, this.version);
  }

  _rebuild() {
    const journal = this.journal;
    this.batches = new Map();
    this.parents = new Map();
    this.children = new Map();
    this.heldAnc = new Map();
    this.journal = [];
    for (const event of journal) {
      this._apply(event);
      this.journal.push(event);
    }
  }

  static diff(previous, next, version) {
    const batches = { added: [], removed: [], changed: [] };
    for (const id of Object.keys(next.batches)) {
      if (!(id in previous.batches)) batches.added.push(id);
    }
    for (const id of Object.keys(previous.batches)) {
      if (!(id in next.batches)) batches.removed.push(id);
    }
    for (const id of Object.keys(next.batches)) {
      if (!(id in previous.batches)) continue;
      const from = previous.batches[id];
      const to = next.batches[id];
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        batches.changed.push({ batch: id, from, to });
      }
    }
    const edges = { added: [], removed: [] };
    const outputs = new Set([...Object.keys(previous.edges), ...Object.keys(next.edges)]);
    for (const output of [...outputs].sort()) {
      const before = new Set(previous.edges[output] || []);
      const after = new Set(next.edges[output] || []);
      for (const input of [...after].sort()) {
        if (!before.has(input)) edges.added.push({ output, input });
      }
      for (const input of [...before].sort()) {
        if (!after.has(input)) edges.removed.push({ output, input });
      }
    }
    return { version, batches, edges };
  }
}

module.exports = { Genealogy, GenealogyError };

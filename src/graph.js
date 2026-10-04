import { EDGE_TYPES, DEFAULT_EDGE_TYPE, LOT_PATTERN, validateAttrs } from './schema.js';
import { hashValue } from './util.js';

export class LineageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LineageError';
  }
}

const edgeKey = (from, to) => `${from}→${to}`;

export class LineageGraph {
  constructor() {
    this.nodes = new Map();
    this.out = new Map();
    this.inn = new Map();
    this.edgeTypes = new Map();
    this.version = 0;
    this.history = [];
    this.redoStack = [];
    this.log = [];
  }

  hasNode(id) {
    return this.nodes.has(id);
  }

  requireNode(id) {
    if (!this.nodes.has(id)) throw new LineageError(`unknown lot '${id}'`);
  }

  addNode(id, attrs) {
    if (typeof id !== 'string' || !LOT_PATTERN.test(id)) {
      throw new LineageError(`invalid lot id '${id}'`);
    }
    if (this.nodes.has(id)) throw new LineageError(`node '${id}' already exists`);
    const err = validateAttrs(attrs);
    if (err) throw new LineageError(err);
    this._addNode(id, attrs);
  }

  _addNode(id, attrs) {
    this.nodes.set(id, { id, attrs: structuredClone(attrs) });
    this.out.set(id, new Set());
    this.inn.set(id, new Set());
  }

  _removeNode(id) {
    for (const to of [...this.out.get(id)]) this._unlink(id, to);
    for (const from of [...this.inn.get(id)]) this._unlink(from, id);
    this.nodes.delete(id);
    this.out.delete(id);
    this.inn.delete(id);
  }

  link(from, to, type = DEFAULT_EDGE_TYPE) {
    this.requireNode(from);
    this.requireNode(to);
    if (!EDGE_TYPES.includes(type)) throw new LineageError(`unknown edge type '${type}'`);
    if (from === to) throw new LineageError(`link ${from} -> ${to} would create a cycle`);
    if (this.out.get(from).has(to)) throw new LineageError(`edge ${from} -> ${to} already exists`);
    if (this._reachable(to, from)) {
      throw new LineageError(`link ${from} -> ${to} would create a cycle`);
    }
    this._link(from, to, type);
  }

  _link(from, to, type = DEFAULT_EDGE_TYPE) {
    this.out.get(from).add(to);
    this.inn.get(to).add(from);
    this.edgeTypes.set(edgeKey(from, to), type);
  }

  unlink(from, to) {
    this.requireNode(from);
    this.requireNode(to);
    if (!this.out.get(from).has(to)) throw new LineageError(`no edge ${from} -> ${to}`);
    this._unlink(from, to);
  }

  _unlink(from, to) {
    this.out.get(from).delete(to);
    this.inn.get(to).delete(from);
    this.edgeTypes.delete(edgeKey(from, to));
  }

  _reachable(from, to) {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const next of this.out.get(cur)) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  _closure(start, adj) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const next of adj.get(cur)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    seen.delete(start);
    return [...seen].sort();
  }

  ancestors(id) {
    this.requireNode(id);
    return this._closure(id, this.inn);
  }

  descendants(id) {
    this.requireNode(id);
    return this._closure(id, this.out);
  }

  shortestPath(from, to) {
    this.requireNode(from);
    this.requireNode(to);
    if (from === to) return [from];
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length > 0) {
      const cur = queue.shift();
      const next = [...this.out.get(cur)].sort();
      for (const n of next) {
        if (prev.has(n)) continue;
        prev.set(n, cur);
        if (n === to) {
          const path = [to];
          let p = cur;
          while (p !== null) {
            path.unshift(p);
            p = prev.get(p);
          }
          return path;
        }
        queue.push(n);
      }
    }
    return null;
  }

  applyCommand(cmd, inverses) {
    switch (cmd.op) {
      case 'add':
        this.addNode(cmd.id, cmd.attrs);
        inverses.push({ op: 'removeNode', id: cmd.id });
        break;
      case 'link':
        this.link(cmd.from, cmd.to, cmd.edge ?? DEFAULT_EDGE_TYPE);
        inverses.push({ op: 'unlink', from: cmd.from, to: cmd.to });
        break;
      case 'unlink': {
        const type = this.edgeTypes.get(edgeKey(cmd.from, cmd.to)) ?? DEFAULT_EDGE_TYPE;
        this.unlink(cmd.from, cmd.to);
        inverses.push({ op: 'link', from: cmd.from, to: cmd.to, edge: type });
        break;
      }
      default:
        throw new LineageError(`unknown op '${cmd.op}'`);
    }
  }

  _applyInverse(inv) {
    switch (inv.op) {
      case 'removeNode':
        this._removeNode(inv.id);
        break;
      case 'link':
        this._link(inv.from, inv.to, inv.edge ?? DEFAULT_EDGE_TYPE);
        break;
      case 'unlink':
        this._unlink(inv.from, inv.to);
        break;
      default:
        throw new LineageError(`unknown inverse op '${inv.op}'`);
    }
  }

  applyTransaction(commands) {
    const inverses = [];
    try {
      for (const cmd of commands) this.applyCommand(cmd, inverses);
    } catch (err) {
      for (let i = inverses.length - 1; i >= 0; i--) this._applyInverse(inverses[i]);
      throw err;
    }
    this.history.push({ commands: structuredClone(commands), inverses });
    this.redoStack = [];
    this.version += 1;
    for (const cmd of commands) this.log.push(structuredClone(cmd));
  }

  undo() {
    const txn = this.history.pop();
    if (!txn) throw new LineageError('nothing to undo');
    for (let i = txn.inverses.length - 1; i >= 0; i--) this._applyInverse(txn.inverses[i]);
    this.redoStack.push(txn);
    this.version += 1;
    this.log.push({ op: 'undo' });
  }

  redo() {
    const txn = this.redoStack.pop();
    if (!txn) throw new LineageError('nothing to redo');
    const inverses = [];
    for (const cmd of txn.commands) this.applyCommand(cmd, inverses);
    txn.inverses = inverses;
    this.history.push(txn);
    this.version += 1;
    this.log.push({ op: 'redo' });
  }

  commandHash() {
    return hashValue(this.log);
  }

  toJSON() {
    const nodes = [...this.nodes.values()]
      .map((n) => ({ id: n.id, attrs: structuredClone(n.attrs) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const edges = [];
    for (const [from, set] of this.out) {
      for (const to of set) {
        edges.push({ from, to, type: this.edgeTypes.get(edgeKey(from, to)) ?? DEFAULT_EDGE_TYPE });
      }
    }
    edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
    return {
      version: this.version,
      nodes,
      edges,
      log: structuredClone(this.log),
      commandHash: this.commandHash(),
    };
  }

  static fromJSON(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new LineageError('graph state must be an object');
    }
    if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
      throw new LineageError("graph state requires 'nodes' and 'edges' arrays");
    }
    if (!Number.isInteger(obj.version) || obj.version < 0) {
      throw new LineageError("graph state requires a non-negative integer 'version'");
    }
    if (!Array.isArray(obj.log)) {
      throw new LineageError("graph state requires a 'log' array");
    }
    const graph = new LineageGraph();
    for (const node of obj.nodes) {
      if (node === null || typeof node !== 'object') throw new LineageError('invalid node entry');
      graph.addNode(node.id, node.attrs);
    }
    for (const edge of obj.edges) {
      if (edge === null || typeof edge !== 'object') throw new LineageError('invalid edge entry');
      graph.link(edge.from, edge.to, edge.type ?? DEFAULT_EDGE_TYPE);
    }
    graph.version = obj.version;
    graph.log = structuredClone(obj.log);
    return graph;
  }
}

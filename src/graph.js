import { defaultSchema, validateProps, LOT_PATTERN } from './schema.js';

export class GraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphError';
  }
}

// Lineage graph with transactional commands, undo/redo and cycle rejection.
// Edge (from -> to) means "from feeds into to" (material flow direction).
export class LineageGraph {
  constructor(schema = defaultSchema) {
    this.schema = schema;
    this.nodes = new Map();
    this.edges = [];
    this.version = 0;
    this.history = [];   // committed transactions (arrays of commands)
    this.redoStack = []; // undone transactions
  }

  static load(state) {
    const g = new LineageGraph();
    if (!state || typeof state !== 'object') throw new GraphError('invalid state file');
    g.version = state.version ?? 0;
    g.history = state.history ?? [];
    g.redoStack = state.redo ?? [];
    g.rebuild();
    return g;
  }

  toJSON() {
    return { version: this.version, history: this.history, redo: this.redoStack };
  }

  rebuild() {
    this.nodes = new Map();
    this.edges = [];
    for (const tx of this.history) {
      for (const cmd of tx) this.applyCommand(cmd);
    }
  }

  hasNode(id) { return this.nodes.has(id); }
  getNode(id) {
    const n = this.nodes.get(id);
    if (!n) throw new GraphError(`unknown lot '${id}'`);
    return n;
  }
  nodeIds() { return [...this.nodes.keys()]; }

  validateCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return 'command must be an object';
    if (cmd.op === 'add') {
      if (typeof cmd.id !== 'string' || !LOT_PATTERN.test(cmd.id)) {
        return `add: id must look like LOT-2025-0001, got ${JSON.stringify(cmd.id)}`;
      }
      if (this.nodes.has(cmd.id)) return `add: lot '${cmd.id}' already exists`;
      if (!(cmd.type in this.schema.nodeTypes)) {
        return `add: unknown node type '${cmd.type}'`;
      }
      return validateProps(this.schema, cmd.props);
    }
    if (cmd.op === 'link' || cmd.op === 'unlink') {
      const edgeType = cmd.edge ?? 'feeds_into';
      if (!(edgeType in this.schema.edgeTypes)) return `${cmd.op}: unknown edge type '${edgeType}'`;
      if (!this.nodes.has(cmd.from)) return `${cmd.op}: unknown lot '${cmd.from}'`;
      if (!this.nodes.has(cmd.to)) return `${cmd.op}: unknown lot '${cmd.to}'`;
      if (cmd.op === 'link') {
        const rule = this.schema.edgeTypes[edgeType];
        const fromType = this.nodes.get(cmd.from).type;
        const toType = this.nodes.get(cmd.to).type;
        if (!rule.from.includes(fromType) || !rule.to.includes(toType)) {
          return `link: ${fromType} -> ${toType} not allowed for edge '${edgeType}'`;
        }
        if (this.edges.some((e) => e.from === cmd.from && e.to === cmd.to && e.edge === edgeType)) {
          return `link: edge ${cmd.from} -> ${cmd.to} already exists`;
        }
        if (cmd.from === cmd.to || this.reachable(cmd.to, cmd.from)) {
          return `link: ${cmd.from} -> ${cmd.to} would create a directed cycle`;
        }
      } else if (!this.edges.some((e) => e.from === cmd.from && e.to === cmd.to && e.edge === edgeType)) {
        return `unlink: no edge ${cmd.from} -> ${cmd.to}`;
      }
      return null;
    }
    return `unknown op '${cmd.op}'`;
  }

  applyCommand(cmd) {
    const err = this.validateCommand(cmd);
    if (err) throw new GraphError(err);
    if (cmd.op === 'add') {
      this.nodes.set(cmd.id, { id: cmd.id, type: cmd.type, props: cmd.props ?? {} });
    } else if (cmd.op === 'link') {
      this.edges.push({ from: cmd.from, to: cmd.to, edge: cmd.edge ?? 'feeds_into' });
    } else if (cmd.op === 'unlink') {
      const edgeType = cmd.edge ?? 'feeds_into';
      this.edges = this.edges.filter(
        (e) => !(e.from === cmd.from && e.to === cmd.to && e.edge === edgeType));
    }
  }

  // Apply a transaction atomically: validate+apply on a scratch copy first.
  applyTransaction(commands) {
    const savedNodes = this.nodes;
    const savedEdges = this.edges;
    this.nodes = new Map(savedNodes);
    this.edges = [...savedEdges];
    try {
      commands.forEach((cmd, i) => {
        try {
          this.applyCommand(cmd);
        } catch (e) {
          throw new GraphError(`command ${i + 1}: ${e.message}`);
        }
      });
    } catch (e) {
      this.nodes = savedNodes;
      this.edges = savedEdges;
      throw e;
    }
    this.history.push(commands);
    this.redoStack = [];
    this.version++;
  }

  undo() {
    const tx = this.history.pop();
    if (!tx) throw new GraphError('nothing to undo');
    this.redoStack.push(tx);
    this.rebuild();
    this.version++;
  }

  redo() {
    const tx = this.redoStack.pop();
    if (!tx) throw new GraphError('nothing to redo');
    this.history.push(tx);
    this.rebuild();
    this.version++;
  }

  successors(id) {
    return this.edges.filter((e) => e.from === id).map((e) => e.to);
  }

  predecessors(id) {
    return this.edges.filter((e) => e.to === id).map((e) => e.from);
  }

  reachable(from, to) {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      for (const next of this.successors(stack.pop())) {
        if (next === to) return true;
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    return false;
  }

  walk(starts, neighbours) {
    const seen = new Set(starts);
    const out = [];
    const stack = [...starts];
    while (stack.length) {
      for (const next of neighbours(stack.pop())) {
        if (!seen.has(next)) { seen.add(next); out.push(next); stack.push(next); }
      }
    }
    return out;
  }

  ancestorsOf(starts) { return this.walk(starts, (id) => this.predecessors(id)); }
  descendantsOf(starts) { return this.walk(starts, (id) => this.successors(id)); }

  shortestPath(from, to) {
    if (!this.nodes.has(from)) throw new GraphError(`unknown lot '${from}'`);
    if (!this.nodes.has(to)) throw new GraphError(`unknown lot '${to}'`);
    if (from === to) return [from];
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of this.successors(cur)) {
        if (!prev.has(next)) {
          prev.set(next, cur);
          if (next === to) {
            const path = [to];
            let p = cur;
            while (p !== null) { path.unshift(p); p = prev.get(p); }
            return path;
          }
          queue.push(next);
        }
      }
    }
    return [];
  }
}

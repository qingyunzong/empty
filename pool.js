'use strict';

class PoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
  }
}

class PoolNode {
  constructor(name, limit) {
    this.name = name;
    this.limit = limit;
    this.held = 0;
    this.spent = 0;
    // Incrementally maintained subtree aggregates (never recomputed by traversal).
    this.subtreeHeld = 0;
    this.subtreeSpent = 0;
    this.parent = null;
    this.children = new Map();
  }

  available() {
    return this.limit - this.held - this.spent;
  }
}

function normalizePath(path) {
  if (Array.isArray(path)) return path.slice();
  if (typeof path === 'string') return path.split('/').filter((s) => s.length > 0);
  throw new PoolError('E_INVALID', `invalid path: ${JSON.stringify(path)}`);
}

function formatPath(segments) {
  return segments.join('/');
}

class Pool {
  constructor() {
    this.root = null;
    this.holds = new Map(); // holdId -> { nodes, amount, state: 'active'|'committed'|'aborted' }
  }

  _resolve(path) {
    const segments = normalizePath(path);
    if (segments.length === 0) throw new PoolError('E_INVALID', 'empty path');
    if (!this.root || segments[0] !== this.root.name) {
      throw new PoolError('E_NOT_FOUND', `unknown path: ${formatPath(segments)}`);
    }
    const nodes = [this.root];
    let current = this.root;
    for (let i = 1; i < segments.length; i++) {
      const next = current.children.get(segments[i]);
      if (!next) throw new PoolError('E_NOT_FOUND', `unknown path: ${formatPath(segments)}`);
      nodes.push(next);
      current = next;
    }
    return { segments, nodes };
  }

  _bump(node, deltaHeld, deltaSpent) {
    node.held += deltaHeld;
    node.spent += deltaSpent;
    for (let p = node; p; p = p.parent) {
      p.subtreeHeld += deltaHeld;
      p.subtreeSpent += deltaSpent;
    }
  }

  addNode(path, limit, journal) {
    const segments = normalizePath(path);
    if (segments.length === 0) throw new PoolError('E_INVALID', 'empty path');
    if (!Number.isFinite(limit) || limit < 0) {
      throw new PoolError('E_INVALID', `invalid limit: ${limit}`);
    }
    if (!this.root) {
      if (segments.length !== 1) {
        throw new PoolError('E_NOT_FOUND', `unknown path: ${formatPath(segments)}`);
      }
      this.root = new PoolNode(segments[0], limit);
      if (journal) journal.push(() => { this.root = null; });
      return { path: formatPath(segments), limit };
    }
    const parentPath = segments.slice(0, -1);
    const { nodes } = this._resolve(parentPath);
    const parent = nodes[nodes.length - 1];
    const name = segments[segments.length - 1];
    if (parent.children.has(name)) {
      throw new PoolError('E_INVALID', `node already exists: ${formatPath(segments)}`);
    }
    const node = new PoolNode(name, limit);
    node.parent = parent;
    parent.children.set(name, node);
    if (journal) journal.push(() => { parent.children.delete(name); });
    return { path: formatPath(segments), limit };
  }

  reserve(path, amount, holdId, journal) {
    if (typeof holdId !== 'string' || holdId.length === 0) {
      throw new PoolError('E_INVALID', `invalid holdId: ${JSON.stringify(holdId)}`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new PoolError('E_INVALID', `invalid amount: ${amount}`);
    }
    if (this.holds.has(holdId)) {
      throw new PoolError('E_DUPLICATE_HOLD', `hold already exists: ${holdId}`);
    }
    const { segments, nodes } = this._resolve(path);
    // Check every node along the path; report the deepest node lacking capacity.
    let deepestFail = null;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].available() < amount) deepestFail = i;
    }
    if (deepestFail !== null) {
      const at = formatPath(segments.slice(0, deepestFail + 1));
      throw new PoolError(
        'E_CAPACITY',
        `insufficient capacity at ${at}: need ${amount}, available ${nodes[deepestFail].available()}`
      );
    }
    for (const node of nodes) this._bump(node, amount, 0);
    this.holds.set(holdId, { nodes, amount, state: 'active' });
    if (journal) {
      journal.push(() => {
        for (const node of nodes) this._bump(node, -amount, 0);
        this.holds.delete(holdId);
      });
    }
    return { holdId, path: formatPath(segments), amount };
  }

  _getHold(holdId, op) {
    const hold = this.holds.get(holdId);
    if (!hold) throw new PoolError('E_ORPHAN_HOLD', `unknown hold: ${holdId}`);
    return hold;
  }

  commit(holdId, journal) {
    const hold = this._getHold(holdId, 'commit');
    if (hold.state === 'committed') return { holdId, idempotent: true }; // repeat commit: no-op
    if (hold.state === 'aborted') {
      throw new PoolError('E_HOLD_STATE', `hold ${holdId} already aborted`);
    }
    for (const node of hold.nodes) this._bump(node, -hold.amount, hold.amount);
    hold.state = 'committed';
    if (journal) {
      journal.push(() => {
        for (const node of hold.nodes) this._bump(node, hold.amount, -hold.amount);
        hold.state = 'active';
      });
    }
    return { holdId, committed: hold.amount };
  }

  abort(holdId, journal) {
    const hold = this._getHold(holdId, 'abort');
    if (hold.state === 'aborted') return { holdId, idempotent: true }; // repeat abort: no-op
    if (hold.state === 'committed') {
      throw new PoolError('E_HOLD_STATE', `hold ${holdId} already committed`);
    }
    for (const node of hold.nodes) this._bump(node, -hold.amount, 0);
    hold.state = 'aborted';
    if (journal) {
      journal.push(() => {
        for (const node of hold.nodes) this._bump(node, hold.amount, 0);
        hold.state = 'active';
      });
    }
    return { holdId, aborted: hold.amount };
  }

  subtreeExposure(path) {
    const { segments, nodes } = this._resolve(path === undefined ? [this.root && this.root.name] : path);
    const node = nodes[nodes.length - 1];
    return {
      path: formatPath(segments),
      held: node.subtreeHeld,
      spent: node.subtreeSpent,
      exposure: node.subtreeHeld + node.subtreeSpent,
    };
  }

  // Atomic batch: any failure rolls every sub-op back to the pre-call state.
  batch(ops, journal) {
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new PoolError('E_INVALID', 'batch requires a non-empty ops array');
    }
    const local = [];
    try {
      const results = ops.map((op) => this._run(op, local));
      if (journal) journal.push(...local.slice().reverse());
      return { applied: results.length, results };
    } catch (err) {
      for (let i = local.length - 1; i >= 0; i--) local[i]();
      throw err;
    }
  }

  _run(op, journal) {
    if (!op || typeof op !== 'object') throw new PoolError('E_INVALID', 'op must be an object');
    switch (op.op) {
      case 'add': return this.addNode(op.path, op.limit, journal);
      case 'reserve': return this.reserve(op.path, op.amount, op.holdId, journal);
      case 'commit': return this.commit(op.holdId, journal);
      case 'abort': return this.abort(op.holdId, journal);
      case 'exposure': return this.subtreeExposure(op.path);
      case 'batch': return this.batch(op.ops, journal);
      default: throw new PoolError('E_INVALID', `unknown op: ${JSON.stringify(op.op)}`);
    }
  }

  run(op) {
    return this._run(op, null);
  }
}

module.exports = { Pool, PoolError };

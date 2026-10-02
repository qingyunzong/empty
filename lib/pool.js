'use strict';

class PoolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class PoolNode {
  constructor(name, limit, parent) {
    this.name = name;
    this.limit = limit;
    this.held = 0;
    this.spent = 0;
    this.parent = parent;
    this.children = new Map();
    // Incrementally maintained subtree aggregates (include self).
    this.subHeld = 0;
    this.subSpent = 0;
  }
  available() {
    return this.limit - this.held - this.spent;
  }
}

function normalizePath(path) {
  if (typeof path !== 'string') throw new PoolError('E_BAD_OP', 'path must be a string');
  return path.split('/').filter((s) => s.length > 0);
}

class Pool {
  constructor() {
    this.root = new PoolNode('', Infinity, null);
    this.holds = new Map(); // holdId -> {id, node, amount, chain, state}
  }

  _resolve(path) {
    let node = this.root;
    for (const seg of normalizePath(path)) {
      node = node.children.get(seg);
      if (!node) throw new PoolError('E_NOT_FOUND', `node not found: ${path}`);
    }
    return node;
  }

  _pathOf(node) {
    const segs = [];
    for (let n = node; n && n.parent; n = n.parent) segs.unshift(n.name);
    return segs.join('/');
  }

  addNode(path, limit) {
    if (typeof limit !== 'number' || !(limit >= 0)) {
      throw new PoolError('E_BAD_OP', `invalid limit for ${path}`);
    }
    const segs = normalizePath(path);
    if (segs.length === 0) throw new PoolError('E_BAD_OP', 'cannot create root');
    let node = this.root;
    for (let i = 0; i < segs.length - 1; i++) {
      node = node.children.get(segs[i]);
      if (!node) throw new PoolError('E_NOT_FOUND', `parent not found for: ${path}`);
    }
    const name = segs[segs.length - 1];
    if (node.children.has(name)) throw new PoolError('E_BAD_OP', `node exists: ${path}`);
    node.children.set(name, new PoolNode(name, limit, node));
    return { path: segs.join('/') };
  }

  _bump(node, dHeld, dSpent) {
    for (let n = node; n; n = n.parent) {
      n.subHeld += dHeld;
      n.subSpent += dSpent;
    }
  }

  reserve(path, amount, holdId) {
    if (typeof amount !== 'number' || !(amount > 0)) {
      throw new PoolError('E_BAD_OP', `invalid amount: ${amount}`);
    }
    if (this.holds.has(holdId)) {
      throw new PoolError('E_DUPLICATE_HOLD', `holdId already exists: ${holdId}`);
    }
    const node = this._resolve(path);
    // Walk from target upward: first failure found is the deepest failing node.
    let deepestFail = null;
    const chain = [];
    for (let n = node; n; n = n.parent) {
      chain.push(n);
      if (n.available() < amount && !deepestFail) deepestFail = n;
    }
    if (deepestFail) {
      throw new PoolError(
        'E_CAPACITY',
        `E_CAPACITY: deepest failing node "${this._pathOf(deepestFail) || '/'}" ` +
          `available=${deepestFail.available()} required=${amount}`
      );
    }
    for (const n of chain) n.held += amount;
    this._bump(node, amount, 0);
    this.holds.set(holdId, { id: holdId, node, amount, chain, state: 'active' });
    return { holdId, state: 'active' };
  }

  _getHold(holdId) {
    const hold = this.holds.get(holdId);
    if (!hold) throw new PoolError('E_ORPHAN_HOLD', `unknown holdId: ${holdId}`);
    return hold;
  }

  // Idempotent: committing an already-finalized hold is a no-op returning its state.
  commit(holdId) {
    const hold = this._getHold(holdId);
    if (hold.state !== 'active') return { holdId, state: hold.state, idempotent: true };
    for (const n of hold.chain) {
      n.held -= hold.amount;
      n.spent += hold.amount;
    }
    this._bump(hold.node, -hold.amount, hold.amount);
    hold.state = 'committed';
    return { holdId, state: 'committed' };
  }

  // Idempotent: aborting an already-finalized hold is a no-op returning its state.
  abort(holdId) {
    const hold = this._getHold(holdId);
    if (hold.state !== 'active') return { holdId, state: hold.state, idempotent: true };
    for (const n of hold.chain) n.held -= hold.amount;
    this._bump(hold.node, -hold.amount, 0);
    hold.state = 'aborted';
    return { holdId, state: 'aborted' };
  }

  // Atomic batch: any failure rolls back all holds created earlier in this call.
  batchReserve(items) {
    const done = [];
    try {
      for (const item of items) {
        this.reserve(item.path, item.amount, item.holdId);
        done.push(item.holdId);
      }
    } catch (err) {
      for (const id of done) {
        const hold = this.holds.get(id);
        if (hold && hold.state === 'active') {
          for (const n of hold.chain) n.held -= hold.amount;
          this._bump(hold.node, -hold.amount, 0);
        }
        this.holds.delete(id); // full rollback: ids are free to reuse
      }
      throw err;
    }
    return { reserved: done };
  }

  // O(1) lookup via incrementally maintained aggregates; no tree traversal.
  subtreeExposure(path) {
    const node = this._resolve(path);
    return { path, held: node.subHeld, spent: node.subSpent, exposure: node.subHeld + node.subSpent };
  }
}

module.exports = { Pool, PoolError };

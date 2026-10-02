'use strict';

const { createHash } = require('node:crypto');

const INVALID_TREE = 'INVALID_TREE';
const INVALID_BATCH = 'INVALID_BATCH';

class BudgetError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isPositiveAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

class BudgetTree {
  constructor(spec) {
    this._nodes = new Map();
    this._batches = new Map();
    this._root = null;
    this._load(spec);
  }

  _load(spec) {
    if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
      throw new BudgetError(INVALID_TREE, 'tree spec must be an object with a non-empty "nodes" array');
    }
    for (const entry of spec.nodes) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new BudgetError(INVALID_TREE, 'every node needs a non-empty string id');
      }
      if (this._nodes.has(entry.id)) {
        throw new BudgetError(INVALID_TREE, `duplicate node id "${entry.id}"`);
      }
      const parent = entry.parent === undefined ? null : entry.parent;
      if (parent !== null && typeof parent !== 'string') {
        throw new BudgetError(INVALID_TREE, `node "${entry.id}" has a non-string parent`);
      }
      if (typeof entry.limit !== 'number' || !Number.isFinite(entry.limit) || entry.limit < 0) {
        throw new BudgetError(INVALID_TREE, `node "${entry.id}" has an invalid limit`);
      }
      this._nodes.set(entry.id, {
        id: entry.id,
        parent,
        limit: entry.limit,
        frozen: entry.frozen === true,
        held: 0,
        used: 0,
        children: [],
      });
    }
    for (const node of this._nodes.values()) {
      if (node.parent === null) {
        if (this._root !== null) {
          throw new BudgetError(INVALID_TREE, `multiple roots: "${this._root}" and "${node.id}"`);
        }
        this._root = node.id;
      } else {
        if (node.parent === node.id) {
          throw new BudgetError(INVALID_TREE, `node "${node.id}" is its own parent`);
        }
        const parent = this._nodes.get(node.parent);
        if (parent === undefined) {
          throw new BudgetError(INVALID_TREE, `node "${node.id}" references unknown parent "${node.parent}"`);
        }
        parent.children.push(node.id);
      }
    }
    if (this._root === null) {
      throw new BudgetError(INVALID_TREE, 'tree has no root; every node sits on a cycle');
    }
    for (const node of this._nodes.values()) {
      const visited = new Set();
      let cursor = node.id;
      while (cursor !== null) {
        if (visited.has(cursor)) {
          throw new BudgetError(INVALID_TREE, `cycle detected involving node "${cursor}"`);
        }
        visited.add(cursor);
        cursor = this._nodes.get(cursor).parent;
      }
    }
    for (const node of this._nodes.values()) {
      node.children.sort();
    }
  }

  _node(id) {
    const node = this._nodes.get(id);
    if (node === undefined) {
      throw new BudgetError(INVALID_TREE, `unknown node "${id}"`);
    }
    return node;
  }

  _batch(id) {
    const batch = this._batches.get(id);
    if (batch === undefined) {
      throw new BudgetError(INVALID_BATCH, `unknown batch "${id}"`);
    }
    return batch;
  }

  rootId() {
    return this._root;
  }

  nodeIds() {
    return [...this._nodes.keys()].sort();
  }

  pathToRoot(id) {
    let node = this._node(id);
    const path = [];
    while (node !== null) {
      path.push(node.id);
      node = node.parent === null ? null : this._nodes.get(node.parent);
    }
    return path;
  }

  reserve(batchId, holds) {
    if (typeof batchId !== 'string' || batchId.length === 0) {
      throw new BudgetError(INVALID_BATCH, 'batch id must be a non-empty string');
    }
    if (this._batches.has(batchId)) {
      throw new BudgetError(INVALID_BATCH, `duplicate batch "${batchId}"`);
    }
    if (!Array.isArray(holds) || holds.length === 0) {
      throw new BudgetError(INVALID_BATCH, 'reserve needs a non-empty holds array');
    }
    const normalized = holds.map((hold, index) => {
      if (hold === null || typeof hold !== 'object') {
        throw new BudgetError(INVALID_BATCH, `hold #${index} is not an object`);
      }
      const node = this._node(hold.node);
      if (!isPositiveAmount(hold.amount)) {
        throw new BudgetError(INVALID_BATCH, `hold #${index} on "${node.id}" has an invalid amount`);
      }
      return { node: node.id, amount: hold.amount };
    });
    const delta = new Map();
    for (const hold of normalized) {
      for (const id of this.pathToRoot(hold.node)) {
        if (this._nodes.get(id).frozen) {
          throw new BudgetError(INVALID_BATCH, `node "${id}" on the path of "${hold.node}" is frozen`, { node: id });
        }
        delta.set(id, (delta.get(id) ?? 0) + hold.amount);
      }
    }
    for (const [id, amount] of delta) {
      const node = this._nodes.get(id);
      const agg = this.subtreeTotals(id);
      if (agg.held + agg.used + amount > node.limit) {
        throw new BudgetError(INVALID_BATCH, `insufficient balance at "${id}"`, {
          node: id,
          limit: node.limit,
          held: agg.held,
          used: agg.used,
          requested: amount,
        });
      }
    }
    for (const hold of normalized) {
      this._nodes.get(hold.node).held += hold.amount;
    }
    const batch = { id: batchId, holds: normalized, state: 'held' };
    this._batches.set(batchId, batch);
    return { batch: batchId, state: batch.state, holds: normalized.map((hold) => ({ ...hold })) };
  }

  cancel(batchId) {
    const batch = this._batch(batchId);
    if (batch.state !== 'held') {
      throw new BudgetError(INVALID_BATCH, `batch "${batchId}" is ${batch.state}, not held`);
    }
    for (const hold of batch.holds) {
      this._nodes.get(hold.node).held -= hold.amount;
    }
    batch.state = 'cancelled';
    return { batch: batchId, state: batch.state };
  }

  release(batchId) {
    return this.cancel(batchId);
  }

  settle(batchId) {
    const batch = this._batch(batchId);
    if (batch.state !== 'held') {
      throw new BudgetError(INVALID_BATCH, `batch "${batchId}" is ${batch.state}, not held`);
    }
    for (const hold of batch.holds) {
      const node = this._nodes.get(hold.node);
      node.held -= hold.amount;
      node.used += hold.amount;
    }
    batch.state = 'settled';
    return { batch: batchId, state: batch.state };
  }

  freeze(nodeId) {
    this._node(nodeId).frozen = true;
    return this.read(nodeId);
  }

  unfreeze(nodeId) {
    this._node(nodeId).frozen = false;
    return this.read(nodeId);
  }

  subtreeTotals(id) {
    this._node(id);
    let held = 0;
    let used = 0;
    const stack = [id];
    while (stack.length > 0) {
      const node = this._nodes.get(stack.pop());
      held += node.held;
      used += node.used;
      for (const child of node.children) {
        stack.push(child);
      }
    }
    return { held, used };
  }

  read(nodeId) {
    const node = this._node(nodeId);
    const subtree = this.subtreeTotals(nodeId);
    return {
      node: node.id,
      parent: node.parent,
      limit: node.limit,
      frozen: node.frozen,
      direct: { held: node.held, used: node.used },
      subtree,
      available: node.limit - subtree.held - subtree.used,
    };
  }

  snapshot() {
    const nodes = {};
    for (const id of this.nodeIds()) {
      const node = this._nodes.get(id);
      nodes[id] = {
        parent: node.parent,
        limit: node.limit,
        frozen: node.frozen,
        held: node.held,
        used: node.used,
      };
    }
    const batches = {};
    for (const id of [...this._batches.keys()].sort()) {
      const batch = this._batches.get(id);
      batches[id] = {
        state: batch.state,
        holds: batch.holds.map((hold) => ({ ...hold })),
      };
    }
    return { nodes, batches };
  }

  stateHash() {
    return createHash('sha256').update(JSON.stringify(this.snapshot())).digest('hex');
  }

  verifyInvariants() {
    for (const node of this._nodes.values()) {
      if (node.held < 0 || node.used < 0) {
        return { kind: 'NEGATIVE_BALANCE', node: node.id, held: node.held, used: node.used };
      }
    }
    for (const node of this._nodes.values()) {
      const agg = this.subtreeTotals(node.id);
      if (agg.held + agg.used > node.limit) {
        return { kind: 'LIMIT_EXCEEDED', node: node.id, limit: node.limit, held: agg.held, used: agg.used };
      }
    }
    const accumulated = new Map([...this._nodes.keys()].map((id) => [id, { held: 0, used: 0 }]));
    for (const node of this._nodes.values()) {
      for (const id of this.pathToRoot(node.id)) {
        const entry = accumulated.get(id);
        entry.held += node.held;
        entry.used += node.used;
      }
    }
    for (const [id, entry] of accumulated) {
      const agg = this.subtreeTotals(id);
      if (entry.held !== agg.held || entry.used !== agg.used) {
        return { kind: 'AGGREGATE_MISMATCH', node: id, bottomUp: agg, topDown: entry };
      }
    }
    return null;
  }
}

module.exports = { BudgetTree, BudgetError, INVALID_TREE, INVALID_BATCH };

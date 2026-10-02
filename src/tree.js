'use strict';

const crypto = require('node:crypto');

class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

class BudgetTree {
  constructor(spec) {
    if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
      throw new BudgetError('INVALID_TREE', 'tree spec must contain a non-empty nodes array');
    }
    this.nodes = new Map();
    for (const entry of spec.nodes) {
      if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new BudgetError('INVALID_TREE', 'every node needs a non-empty string id');
      }
      if (this.nodes.has(entry.id)) {
        throw new BudgetError('INVALID_TREE', `duplicate node id: ${entry.id}`);
      }
      if (entry.parent !== null && entry.parent !== undefined && typeof entry.parent !== 'string') {
        throw new BudgetError('INVALID_TREE', `node ${entry.id} has a non-string parent`);
      }
      if (typeof entry.capacity !== 'number' || !Number.isFinite(entry.capacity) || entry.capacity < 0) {
        throw new BudgetError('INVALID_TREE', `node ${entry.id} has an invalid capacity`);
      }
      this.nodes.set(entry.id, {
        id: entry.id,
        parent: entry.parent == null ? null : entry.parent,
        capacity: entry.capacity,
        children: [],
        heldOwn: 0,
        usedOwn: 0,
        heldTotal: 0,
        usedTotal: 0,
        frozen: false,
      });
    }
    for (const node of this.nodes.values()) {
      if (node.parent === null) continue;
      const parent = this.nodes.get(node.parent);
      if (!parent) {
        throw new BudgetError('INVALID_TREE', `node ${node.id} references unknown parent ${node.parent}`);
      }
      parent.children.push(node.id);
    }
    const roots = new Set();
    for (const node of this.nodes.values()) {
      const seen = new Set();
      let cur = node;
      while (cur.parent !== null) {
        if (seen.has(cur.id)) {
          throw new BudgetError('INVALID_TREE', `cycle detected involving node ${cur.id}`);
        }
        seen.add(cur.id);
        cur = this.nodes.get(cur.parent);
      }
      roots.add(cur.id);
    }
    if (roots.size !== 1) {
      throw new BudgetError('INVALID_TREE', `tree must have exactly one root, found ${roots.size}`);
    }
    this.root = [...roots][0];
    this.batches = new Map();
  }

  _pathToRoot(id) {
    const path = [];
    let cur = this.nodes.get(id);
    while (cur) {
      path.push(cur.id);
      cur = cur.parent === null ? null : this.nodes.get(cur.parent);
    }
    return path;
  }

  _subtree(id) {
    const out = [];
    const stack = [id];
    while (stack.length > 0) {
      const cur = this.nodes.get(stack.pop());
      out.push(cur.id);
      for (const child of cur.children) stack.push(child);
    }
    return out;
  }

  reserve(batchId, items) {
    if (typeof batchId !== 'string' || batchId.length === 0) {
      throw new BudgetError('INVALID_BATCH', 'batchId must be a non-empty string');
    }
    if (this.batches.has(batchId)) {
      throw new BudgetError('INVALID_BATCH', `duplicate batch id: ${batchId}`);
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new BudgetError('INVALID_BATCH', 'items must be a non-empty array');
    }
    const increments = new Map();
    const ownIncrements = new Map();
    for (const item of items) {
      const node = item && typeof item.node === 'string' ? this.nodes.get(item.node) : undefined;
      if (!node) {
        throw new BudgetError('INVALID_TREE', `unknown node: ${item && item.node}`);
      }
      if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0) {
        throw new BudgetError('INVALID_BATCH', `amount for node ${node.id} must be a positive number`);
      }
      if (node.frozen) {
        throw new BudgetError('NODE_FROZEN', `node ${node.id} is frozen`);
      }
      ownIncrements.set(node.id, (ownIncrements.get(node.id) || 0) + item.amount);
      for (const id of this._pathToRoot(node.id)) {
        increments.set(id, (increments.get(id) || 0) + item.amount);
      }
    }
    for (const [id, inc] of increments) {
      const node = this.nodes.get(id);
      if (node.heldTotal + node.usedTotal + inc > node.capacity) {
        throw new BudgetError(
          'INSUFFICIENT_BALANCE',
          `node ${id} capacity ${node.capacity} would be exceeded (held=${node.heldTotal} used=${node.usedTotal} requested=${inc})`,
        );
      }
    }
    for (const [id, inc] of increments) {
      this.nodes.get(id).heldTotal += inc;
    }
    for (const [id, inc] of ownIncrements) {
      this.nodes.get(id).heldOwn += inc;
    }
    this.batches.set(batchId, { status: 'held', increments, ownIncrements });
    return { batchId, status: 'held' };
  }

  _heldBatch(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new BudgetError('INVALID_BATCH', `unknown batch id: ${batchId}`);
    }
    if (batch.status !== 'held') {
      throw new BudgetError('INVALID_BATCH', `batch ${batchId} is not held (status=${batch.status})`);
    }
    return batch;
  }

  cancel(batchId) {
    const batch = this._heldBatch(batchId);
    for (const [id, inc] of batch.increments) {
      this.nodes.get(id).heldTotal -= inc;
    }
    for (const [id, inc] of batch.ownIncrements) {
      this.nodes.get(id).heldOwn -= inc;
    }
    batch.status = 'cancelled';
    return { batchId, status: 'cancelled' };
  }

  settle(batchId) {
    const batch = this._heldBatch(batchId);
    for (const [id, inc] of batch.increments) {
      const node = this.nodes.get(id);
      node.heldTotal -= inc;
      node.usedTotal += inc;
    }
    for (const [id, inc] of batch.ownIncrements) {
      const node = this.nodes.get(id);
      node.heldOwn -= inc;
      node.usedOwn += inc;
    }
    batch.status = 'settled';
    return { batchId, status: 'settled' };
  }

  freeze(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new BudgetError('INVALID_TREE', `unknown node: ${nodeId}`);
    node.frozen = true;
    return { node: nodeId, frozen: true };
  }

  unfreeze(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new BudgetError('INVALID_TREE', `unknown node: ${nodeId}`);
    node.frozen = false;
    return { node: nodeId, frozen: false };
  }

  read(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new BudgetError('INVALID_TREE', `unknown node: ${nodeId}`);
    const direct = {
      capacity: node.capacity,
      held: node.heldOwn,
      used: node.usedOwn,
      available: node.capacity - node.heldTotal - node.usedTotal,
    };
    let held = 0;
    let used = 0;
    let capacity = 0;
    for (const id of this._subtree(nodeId)) {
      const n = this.nodes.get(id);
      held += n.heldOwn;
      used += n.usedOwn;
      capacity += n.capacity;
    }
    const aggregate = {
      capacity,
      held,
      used,
      available: node.capacity - node.heldTotal - node.usedTotal,
    };
    return { node: nodeId, frozen: node.frozen, direct, aggregate };
  }

  snapshot() {
    const nodes = {};
    for (const id of [...this.nodes.keys()].sort()) {
      const n = this.nodes.get(id);
      nodes[id] = {
        heldOwn: n.heldOwn,
        usedOwn: n.usedOwn,
        heldTotal: n.heldTotal,
        usedTotal: n.usedTotal,
        frozen: n.frozen,
      };
    }
    const batches = {};
    for (const id of [...this.batches.keys()].sort()) {
      batches[id] = this.batches.get(id).status;
    }
    return { nodes, batches };
  }

  stateHash() {
    return crypto.createHash('sha256').update(stableStringify(this.snapshot())).digest('hex');
  }
}

module.exports = { BudgetTree, BudgetError, stableStringify };

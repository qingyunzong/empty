'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BudgetTree } = require('../src/tree');

// Independent reference model: does NOT propagate holds to ancestors.
// Occupancy is derived by summing batch item lists over subtrees at read time.
class ModelTree {
  constructor(spec) {
    this.cap = new Map();
    this.parent = new Map();
    this.frozen = new Set();
    for (const n of spec.nodes) {
      this.cap.set(n.id, n.capacity);
      this.parent.set(n.id, n.parent == null ? null : n.parent);
    }
    this.batches = new Map();
  }

  inSubtree(ancestor, node) {
    let cur = node;
    while (cur !== null && cur !== undefined) {
      if (cur === ancestor) return true;
      cur = this.parent.get(cur);
    }
    return false;
  }

  sumAt(id, status, ownOnly, extraItems) {
    let sum = 0;
    for (const batch of this.batches.values()) {
      if (batch.status !== status) continue;
      for (const item of batch.items) {
        const hit = ownOnly ? item.node === id : this.inSubtree(id, item.node);
        if (hit) sum += item.amount;
      }
    }
    if (extraItems) {
      for (const item of extraItems) {
        const hit = ownOnly ? item.node === id : this.inSubtree(id, item.node);
        if (hit) sum += item.amount;
      }
    }
    return sum;
  }

  reserve(batchId, items) {
    if (typeof batchId !== 'string' || batchId.length === 0) return { code: 'INVALID_BATCH' };
    if (this.batches.has(batchId)) return { code: 'INVALID_BATCH' };
    if (!Array.isArray(items) || items.length === 0) return { code: 'INVALID_BATCH' };
    for (const item of items) {
      if (!item || typeof item.node !== 'string' || !this.cap.has(item.node)) return { code: 'INVALID_TREE' };
      if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0) {
        return { code: 'INVALID_BATCH' };
      }
      if (this.frozen.has(item.node)) return { code: 'NODE_FROZEN' };
    }
    for (const id of this.cap.keys()) {
      const projected = this.sumAt(id, 'held', false, items) + this.sumAt(id, 'settled', false);
      if (projected > this.cap.get(id)) return { code: 'INSUFFICIENT_BALANCE' };
    }
    this.batches.set(batchId, {
      status: 'held',
      items: items.map((it) => ({ node: it.node, amount: it.amount })),
    });
    return { ok: true };
  }

  cancel(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return { code: 'INVALID_BATCH' };
    if (batch.status !== 'held') return { code: 'INVALID_BATCH' };
    batch.status = 'cancelled';
    return { ok: true };
  }

  settle(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return { code: 'INVALID_BATCH' };
    if (batch.status !== 'held') return { code: 'INVALID_BATCH' };
    batch.status = 'settled';
    return { ok: true };
  }

  freeze(node) {
    if (!this.cap.has(node)) return { code: 'INVALID_TREE' };
    this.frozen.add(node);
    return { ok: true };
  }

  unfreeze(node) {
    if (!this.cap.has(node)) return { code: 'INVALID_TREE' };
    this.frozen.delete(node);
    return { ok: true };
  }

  read(id) {
    if (!this.cap.has(id)) return { code: 'INVALID_TREE' };
    const capacity = this.cap.get(id);
    const heldTotal = this.sumAt(id, 'held', false);
    const usedTotal = this.sumAt(id, 'settled', false);
    let subtreeCap = 0;
    for (const nid of this.cap.keys()) {
      if (this.inSubtree(id, nid)) subtreeCap += this.cap.get(nid);
    }
    return {
      ok: true,
      value: {
        node: id,
        frozen: this.frozen.has(id),
        direct: {
          capacity,
          held: this.sumAt(id, 'held', true),
          used: this.sumAt(id, 'settled', true),
          available: capacity - heldTotal - usedTotal,
        },
        aggregate: {
          capacity: subtreeCap,
          held: heldTotal,
          used: usedTotal,
          available: capacity - heldTotal - usedTotal,
        },
      },
    };
  }
}

const SPEC = {
  nodes: [
    { id: 'root', parent: null, capacity: 6 },
    { id: 'c1', parent: 'root', capacity: 4 },
    { id: 'c2', parent: 'root', capacity: 4 },
  ],
};

const OPS = [
  { op: 'reserve', batchId: 'b1', items: [{ node: 'c1', amount: 2 }] },
  { op: 'reserve', batchId: 'b2', items: [{ node: 'c2', amount: 3 }] },
  { op: 'reserve', batchId: 'b3', items: [{ node: 'c1', amount: 1 }, { node: 'c2', amount: 2 }] },
  { op: 'reserve', batchId: 'b4', items: [{ node: 'c1', amount: 5 }] },
  { op: 'cancel', batchId: 'b1' },
  { op: 'cancel', batchId: 'b2' },
  { op: 'cancel', batchId: 'b3' },
  { op: 'settle', batchId: 'b1' },
  { op: 'settle', batchId: 'b2' },
  { op: 'settle', batchId: 'b3' },
  { op: 'freeze', node: 'c1' },
  { op: 'unfreeze', node: 'c1' },
];

function libApply(tree, op) {
  try {
    switch (op.op) {
      case 'reserve': tree.reserve(op.batchId, op.items); break;
      case 'cancel': tree.cancel(op.batchId); break;
      case 'settle': tree.settle(op.batchId); break;
      case 'freeze': tree.freeze(op.node); break;
      case 'unfreeze': tree.unfreeze(op.node); break;
      default: return { code: 'INVALID_OP' };
    }
    return { ok: true };
  } catch (e) {
    return { code: e.code };
  }
}

function libRead(tree, id) {
  try {
    return { ok: true, value: tree.read(id) };
  } catch (e) {
    return { code: e.code };
  }
}

function* sequences(alphabet, maxLen) {
  const current = [];
  function* rec(remaining) {
    if (remaining === 0) {
      yield current;
      return;
    }
    for (const op of alphabet) {
      current.push(op);
      yield* rec(remaining - 1);
      current.pop();
    }
  }
  for (let len = 1; len <= maxLen; len++) yield* rec(len);
}

test('depth-2 tree, all op sequences of length <= 4 match the independent model', () => {
  let checked = 0;
  for (const seq of sequences(OPS, 4)) {
    const lib = new BudgetTree(SPEC);
    const model = new ModelTree(SPEC);
    for (let step = 0; step < seq.length; step++) {
      const op = seq[step];
      const libResult = libApply(lib, op);
      const modelResult = model[op.op === 'reserve' ? 'reserve' : op.op].call(
        model,
        ...(op.op === 'reserve' ? [op.batchId, op.items] : op.op === 'freeze' || op.op === 'unfreeze' ? [op.node] : [op.batchId]),
      );
      const label = `seq=${seq.slice(0, step + 1).map((o) => o.op + ':' + (o.batchId || o.node || '')).join(',')}`;
      assert.deepEqual(
        { ok: !!libResult.ok, code: libResult.code },
        { ok: !!modelResult.ok, code: modelResult.code },
        `accept/reject mismatch at ${label}`,
      );
      for (const id of ['root', 'c1', 'c2']) {
        assert.deepEqual(libRead(lib, id), model.read(id), `read(${id}) mismatch at ${label}`);
      }
    }
    checked++;
  }
  assert.equal(checked, 12 + 144 + 1728 + 20736);
});

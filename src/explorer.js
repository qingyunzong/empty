'use strict';

const crypto = require('node:crypto');
const { BudgetTree, BudgetError } = require('./tree');

function* interleavings(actors) {
  const indexed = actors.map((actor, i) => ({ actor, i }));
  indexed.sort((x, y) => (x.actor.id < y.actor.id ? -1 : x.actor.id > y.actor.id ? 1 : x.i - y.i));
  const progress = actors.map(() => 0);
  const total = actors.reduce((sum, a) => sum + a.ops.length, 0);
  const current = [];
  function* rec(remaining) {
    if (remaining === 0) {
      yield current.slice();
      return;
    }
    for (const { actor, i } of indexed) {
      if (progress[i] < actor.ops.length) {
        const opIndex = progress[i];
        current.push({ actor: actor.id, index: opIndex, op: actor.ops[opIndex] });
        progress[i] += 1;
        yield* rec(remaining - 1);
        progress[i] -= 1;
        current.pop();
      }
    }
  }
  yield* rec(total);
}

function applyOp(tree, op) {
  switch (op.op) {
    case 'reserve':
      return tree.reserve(op.batchId, op.items);
    case 'cancel':
      return tree.cancel(op.batchId);
    case 'settle':
      return tree.settle(op.batchId);
    case 'freeze':
      return tree.freeze(op.node);
    case 'unfreeze':
      return tree.unfreeze(op.node);
    default:
      throw new BudgetError('INVALID_OP', `unknown op: ${op.op}`);
  }
}

function findInvariantViolation(tree) {
  for (const [id, n] of tree.nodes) {
    if (!(n.heldOwn >= 0) || !(n.usedOwn >= 0) || !(n.heldTotal >= 0) || !(n.usedTotal >= 0)) {
      return { node: id, reason: 'negative occupancy' };
    }
    if (n.heldTotal + n.usedTotal > n.capacity) {
      return { node: id, reason: `occupancy ${n.heldTotal + n.usedTotal} exceeds capacity ${n.capacity}` };
    }
    if (n.heldOwn > n.heldTotal || n.usedOwn > n.usedTotal) {
      return { node: id, reason: 'own occupancy exceeds subtree total' };
    }
  }
  return null;
}

function ancestorChain(tree, nodeId) {
  const chain = [];
  let cur = tree.nodes.get(nodeId);
  while (cur) {
    chain.push({
      id: cur.id,
      capacity: cur.capacity,
      held: cur.heldTotal,
      used: cur.usedTotal,
      heldOwn: cur.heldOwn,
      usedOwn: cur.usedOwn,
    });
    cur = cur.parent === null ? null : tree.nodes.get(cur.parent);
  }
  return chain.reverse();
}

function opFocusNode(op) {
  if (op.op === 'reserve' && Array.isArray(op.items) && op.items.length > 0) return op.items[0].node;
  if ((op.op === 'freeze' || op.op === 'unfreeze') && typeof op.node === 'string') return op.node;
  return null;
}

function explore(treeSpec, actorsSpec) {
  if (!Array.isArray(actorsSpec)) {
    throw new BudgetError('INVALID_ACTORS', 'actors spec must be an array of {id, ops}');
  }
  const actors = actorsSpec.map((a) => {
    if (!a || typeof a.id !== 'string' || !Array.isArray(a.ops)) {
      throw new BudgetError('INVALID_ACTORS', 'each actor needs a string id and an ops array');
    }
    return { id: a.id, ops: a.ops };
  });
  let interleavingCount = 0;
  let stepCount = 0;
  const seenStates = new Set();
  const certificateHash = crypto.createHash('sha256');
  for (const sequence of interleavings(actors)) {
    interleavingCount += 1;
    const tree = new BudgetTree(treeSpec);
    for (let k = 0; k < sequence.length; k++) {
      const step = sequence[k];
      stepCount += 1;
      let error = null;
      try {
        applyOp(tree, step.op);
      } catch (e) {
        error = e;
      }
      let failure = null;
      const expect = step.op && step.op.expect;
      if (error && !(error instanceof BudgetError)) {
        failure = { kind: 'internal_error', message: String(error && error.message) };
      } else if (error && expect === 'ok') {
        failure = { kind: 'unexpected_reject', code: error.code, message: error.message };
      } else if (!error && expect === 'reject') {
        failure = { kind: 'unexpected_success' };
      } else if (!error) {
        const violation = findInvariantViolation(tree);
        if (violation) failure = { kind: 'invariant', ...violation };
      }
      const hash = tree.stateHash();
      seenStates.add(hash);
      if (failure) {
        const focus = failure.node || opFocusNode(step.op) || tree.root;
        return {
          safe: false,
          counterexample: {
            sequence: sequence.slice(0, k + 1).map((s) => ({ actor: s.actor, index: s.index, op: s.op })),
            failure,
            ancestorChain: ancestorChain(tree, focus),
            stateHash: hash,
          },
          explored: { interleavings: interleavingCount, steps: stepCount },
        };
      }
    }
    certificateHash.update(tree.stateHash());
    certificateHash.update('\n');
  }
  return {
    safe: true,
    certificate: {
      interleavings: interleavingCount,
      steps: stepCount,
      uniqueStates: seenStates.size,
      hash: certificateHash.digest('hex'),
    },
  };
}

module.exports = { interleavings, explore, applyOp, ancestorChain, findInvariantViolation };

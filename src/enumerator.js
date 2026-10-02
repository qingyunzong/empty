'use strict';

const { createHash } = require('node:crypto');
const { BudgetTree, BudgetError, INVALID_BATCH } = require('./tree');

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const OP_FIELDS = {
  reserve: ['batch', 'holds'],
  cancel: ['batch'],
  release: ['batch'],
  settle: ['batch'],
  freeze: ['node'],
  unfreeze: ['node'],
};

function validateOp(op, actorId, index) {
  if (op === null || typeof op !== 'object' || typeof op.op !== 'string') {
    throw new BudgetError(INVALID_BATCH, `actor "${actorId}" op #${index} needs an "op" string`);
  }
  const fields = OP_FIELDS[op.op];
  if (fields === undefined) {
    throw new BudgetError(INVALID_BATCH, `actor "${actorId}" op #${index} has unknown op "${op.op}"`);
  }
  for (const field of fields) {
    if (op[field] === undefined) {
      throw new BudgetError(INVALID_BATCH, `actor "${actorId}" op #${index} (${op.op}) is missing "${field}"`);
    }
  }
}

function validateActors(actors) {
  if (!Array.isArray(actors)) {
    throw new BudgetError(INVALID_BATCH, 'actors must be an array');
  }
  const seen = new Set();
  for (const actor of actors) {
    if (actor === null || typeof actor !== 'object' || typeof actor.id !== 'string' || actor.id.length === 0) {
      throw new BudgetError(INVALID_BATCH, 'every actor needs a non-empty string id');
    }
    if (seen.has(actor.id)) {
      throw new BudgetError(INVALID_BATCH, `duplicate actor id "${actor.id}"`);
    }
    seen.add(actor.id);
    if (!Array.isArray(actor.ops)) {
      throw new BudgetError(INVALID_BATCH, `actor "${actor.id}" needs an "ops" array`);
    }
    actor.ops.forEach((op, index) => validateOp(op, actor.id, index));
  }
}

function applyOp(tree, op) {
  switch (op.op) {
    case 'reserve':
      return tree.reserve(op.batch, op.holds);
    case 'cancel':
    case 'release':
      return tree.cancel(op.batch);
    case 'settle':
      return tree.settle(op.batch);
    case 'freeze':
      return tree.freeze(op.node);
    case 'unfreeze':
      return tree.unfreeze(op.node);
    default:
      throw new BudgetError(INVALID_BATCH, `unknown op "${op.op}"`);
  }
}

function* interleavings(actors) {
  const order = actors
    .map((actor, index) => ({ id: actor.id, index }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const positions = actors.map(() => 0);
  const total = actors.reduce((sum, actor) => sum + actor.ops.length, 0);
  const trace = [];
  function* walk(depth) {
    if (depth === total) {
      yield trace.slice();
      return;
    }
    for (const { index } of order) {
      if (positions[index] < actors[index].ops.length) {
        const opIndex = positions[index];
        trace.push({ actor: actors[index].id, opIndex, op: actors[index].ops[opIndex] });
        positions[index] += 1;
        yield* walk(depth + 1);
        positions[index] -= 1;
        trace.pop();
      }
    }
  }
  yield* walk(0);
}

function ancestorChain(tree, nodeId) {
  return tree.pathToRoot(nodeId).map((id) => {
    const view = tree.read(id);
    return {
      node: id,
      limit: view.limit,
      direct: view.direct,
      subtree: view.subtree,
      available: view.available,
    };
  });
}

function explore(treeSpec, actors, options = {}) {
  validateActors(actors);
  new BudgetTree(treeSpec);
  const check = options.check ?? ((tree) => tree.verifyInvariants());
  const finalHashes = new Set();
  const rejections = new Set();
  let checked = 0;
  let steps = 0;
  for (const trace of interleavings(actors)) {
    checked += 1;
    const tree = new BudgetTree(treeSpec);
    for (let index = 0; index < trace.length; index += 1) {
      const step = trace[index];
      steps += 1;
      let outcome;
      try {
        outcome = { ok: true, result: applyOp(tree, step.op) };
      } catch (err) {
        if (!(err instanceof BudgetError)) {
          throw err;
        }
        outcome = { ok: false, code: err.code, message: err.message };
        rejections.add(err.code);
      }
      const violation = check(tree, { trace, stepIndex: index, step, outcome });
      if (violation) {
        return {
          status: 'VIOLATION',
          order: 'lexicographic-by-actor-id',
          interleavingsChecked: checked,
          counterexample: {
            kind: violation.kind ?? 'INVARIANT_VIOLATION',
            violation,
            trace: trace.slice(0, index + 1).map((entry) => ({ actor: entry.actor, op: entry.op })),
            ancestorChain: violation.node === undefined ? [] : ancestorChain(tree, violation.node),
            stateHash: tree.stateHash(),
            state: tree.snapshot(),
            note: 'lexicographically smallest violating interleaving (actor-id order)',
          },
        };
      }
    }
    finalHashes.add(tree.stateHash());
  }
  const body = {
    status: 'SAFE',
    order: 'lexicographic-by-actor-id',
    treeHash: hashValue(treeSpec),
    actorsHash: hashValue(actors),
    interleavings: checked,
    stepsExecuted: steps,
    distinctFinalStates: finalHashes.size,
    finalStateHashes: [...finalHashes].sort(),
    rejectionsSeen: [...rejections].sort(),
    invariants: ['held>=0', 'used>=0', 'subtree(held+used)<=limit', 'aggregates-consistent'],
  };
  return { ...body, certificateHash: hashValue(body) };
}

module.exports = { interleavings, explore, applyOp, validateActors, ancestorChain };

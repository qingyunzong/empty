'use strict';
const { isDeepStrictEqual } = require('node:util');
const treeOps = require('./tree');

class ConflictError extends Error {
  constructor(message, op) {
    super(message);
    this.name = 'ConflictError';
    this.op = op;
  }
}

function applyOp(tree, op) {
  switch (op.op) {
    case 'set':
      treeOps.set(tree, op.path, op.value);
      return;
    case 'del':
      if (!treeOps.del(tree, op.path)) {
        throw new ConflictError(`del: path "${op.path}" no longer exists in the new context`, op);
      }
      return;
    case 'move': {
      if (!treeOps.has(tree, op.from)) {
        throw new ConflictError(
          `move: record "${op.from}" was moved or removed on the trunk`,
          op,
        );
      }
      const value = treeOps.get(tree, op.from);
      treeOps.del(tree, op.from);
      treeOps.set(tree, op.to, value);
      return;
    }
    case 'replace': {
      if (!treeOps.has(tree, op.path) || !isDeepStrictEqual(treeOps.get(tree, op.path), op.old)) {
        throw new ConflictError(
          `replace: expected old value at "${op.path}" does not match the new context`,
          op,
        );
      }
      treeOps.set(tree, op.path, op.new);
      return;
    }
    case 'check': {
      if (!treeOps.has(tree, op.path) || !isDeepStrictEqual(treeOps.get(tree, op.path), op.value)) {
        throw new ConflictError(
          `check: expected value at "${op.path}" does not match the new context`,
          op,
        );
      }
      return;
    }
    default:
      throw new Error(`unknown patch op: ${String(op.op)}`);
  }
}

function applyPatch(tree, patch) {
  for (const op of patch) applyOp(tree, op);
  return tree;
}

module.exports = { ConflictError, applyOp, applyPatch };

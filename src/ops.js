'use strict';

class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchError';
  }
}

const OP_TYPES = new Set([
  'set-attr',
  'delete-attr',
  'put-file',
  'delete-file',
  'append-chain',
  'pop-chain',
]);

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// An op is dangerous when it destroys or overwrites existing data and
// therefore must carry an explicit inverse op supplied by the caller.
function isDangerous(state, op) {
  switch (op.op) {
    case 'set-attr':
      return hasKey(state.attributes, op.path);
    case 'delete-attr':
      return true;
    case 'put-file':
      return hasKey(state.files, op.path);
    case 'delete-file':
      return true;
    case 'append-chain':
      return false;
    case 'pop-chain':
      return true;
    default:
      throw new PatchError(`unknown op: ${String(op.op)}`);
  }
}

// Applies only the data change of an op; version bookkeeping is done by the
// caller so the same function can serve forward apply and rollback.
function applyDataOp(state, op) {
  switch (op.op) {
    case 'set-attr':
      state.attributes[op.path] = op.value;
      return;
    case 'delete-attr':
      if (!hasKey(state.attributes, op.path)) {
        throw new PatchError(`no such attribute: ${op.path}`);
      }
      delete state.attributes[op.path];
      return;
    case 'put-file':
      state.files[op.path] = op.value;
      return;
    case 'delete-file':
      if (!hasKey(state.files, op.path)) {
        throw new PatchError(`no such file: ${op.path}`);
      }
      delete state.files[op.path];
      return;
    case 'append-chain':
      state.chain.push(op.entry);
      return;
    case 'pop-chain':
      if (state.chain.length === 0) {
        throw new PatchError('evidence chain is empty');
      }
      state.chain.pop();
      return;
    default:
      throw new PatchError(`unknown op: ${String(op.op)}`);
  }
}

// Inverse for non-dangerous ops can be derived from the current state.
function deriveInverse(op) {
  switch (op.op) {
    case 'set-attr':
      return { op: 'delete-attr', path: op.path };
    case 'put-file':
      return { op: 'delete-file', path: op.path };
    case 'append-chain':
      return { op: 'pop-chain' };
    default:
      throw new PatchError(`cannot derive inverse for op: ${op.op}`);
  }
}

function validateFields(op, index) {
  const need = (cond, msg) => {
    if (!cond) throw new PatchError(`op ${index}: ${msg}`);
  };
  switch (op.op) {
    case 'set-attr':
      need(typeof op.path === 'string' && op.path.length > 0, 'path must be a non-empty string');
      need(hasKey(op, 'value'), 'value is required');
      break;
    case 'delete-attr':
      need(typeof op.path === 'string' && op.path.length > 0, 'path must be a non-empty string');
      break;
    case 'put-file':
      need(typeof op.path === 'string' && op.path.length > 0, 'path must be a non-empty string');
      need(typeof op.value === 'string', 'value must be a string');
      break;
    case 'delete-file':
      need(typeof op.path === 'string' && op.path.length > 0, 'path must be a non-empty string');
      break;
    case 'append-chain':
      need(hasKey(op, 'entry'), 'entry is required');
      break;
    case 'pop-chain':
      break;
    default:
      throw new PatchError(`unknown op: ${String(op.op)}`);
  }
}

// Validates the whole patch against a cloned state before anything touches
// disk. Returns the undo chain (one inverse op per patch op, in order).
function validatePatch(state, ops) {
  if (!Array.isArray(ops)) {
    throw new PatchError('patch must contain an ops array');
  }
  const sim = {
    version: state.version,
    attributes: { ...state.attributes },
    files: { ...state.files },
    chain: [...state.chain],
  };
  const undo = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new PatchError(`op ${i}: must be an object`);
    }
    if (!OP_TYPES.has(op.op)) {
      throw new PatchError(`unknown op: ${String(op.op)}`);
    }
    if (!Number.isInteger(op.expectVersion)) {
      throw new PatchError(`op ${i}: expectVersion must be an integer`);
    }
    if (op.expectVersion !== sim.version) {
      throw new PatchError(
        `op ${i}: conditional version mismatch, expected ${op.expectVersion} but state is at ${sim.version}`
      );
    }
    validateFields(op, i);
    if (isDangerous(sim, op)) {
      if (op.inverse === undefined) {
        throw new PatchError(`op ${i}: dangerous change (${op.op} ${op.path}) requires an inverse op`);
      }
      if (op.inverse === null || typeof op.inverse !== 'object' || !OP_TYPES.has(op.inverse.op)) {
        throw new PatchError(`op ${i}: inverse is not a known op`);
      }
      undo.push(op.inverse);
    } else {
      undo.push(deriveInverse(op));
    }
    try {
      applyDataOp(sim, op);
    } catch (err) {
      throw new PatchError(`op ${i}: ${err.message}`);
    }
    sim.version += 1;
  }
  return undo;
}

module.exports = { PatchError, OP_TYPES, isDangerous, applyDataOp, validatePatch };

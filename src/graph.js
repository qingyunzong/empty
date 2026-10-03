// Pure evidence-graph state machine: no I/O, fully deterministic.
import { E } from './errors.js';

export function createState() {
  return { facts: {}, derived: {}, sources: {} };
}

export function normalizeDerived(payload) {
  const inputs = [...payload.inputs];
  const min = payload.min ?? (payload.op === 'count' ? inputs.length : 1);
  return { id: payload.id, op: payload.op, min, inputs };
}

// Cycle check on dependency edges (node -> its inputs).
// Adding/replacing derived node `id` with `inputs` creates a cycle iff
// `id` is reachable from any input following existing derived rules.
export function wouldCycle(state, id, inputs) {
  if (inputs.includes(id)) return true;
  const seen = new Set();
  const stack = [...inputs];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === id) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    const d = state.derived[n];
    if (d) stack.push(...d.inputs);
  }
  return false;
}

// Command-time validation. Replay never validates: the log is the source of truth.
export function validateEvent(state, type, payload) {
  switch (type) {
    case 'ADD_DERIVED': {
      const replaced = state.derived[payload.id] ?? null;
      if (replaced) delete state.derived[payload.id];
      const cyclic = wouldCycle(state, payload.id, payload.inputs);
      if (replaced) state.derived[payload.id] = replaced;
      if (cyclic) {
        throw E.cycle(`derive ${payload.id}: inputs [${payload.inputs.join(', ')}] would create a cycle`);
      }
      break;
    }
    case 'REVOKE_SOURCE':
    case 'RESTORE_SOURCE':
      if (!state.sources[payload.id]) {
        throw E.sourceGone(`source ${payload.id} does not exist`);
      }
      break;
    default:
      break;
  }
}

export function applyEvent(state, type, payload) {
  switch (type) {
    case 'ADD_FACT':
      state.facts[payload.id] = {
        source: payload.source,
        value: payload.value ?? 1,
        deleted: false,
      };
      state.sources[payload.source] ??= { revoked: false };
      break;
    case 'DELETE_FACT':
      if (state.facts[payload.id]) state.facts[payload.id].deleted = true;
      break;
    case 'ADD_DERIVED':
      state.derived[payload.id] = {
        op: payload.op,
        min: payload.min,
        inputs: [...payload.inputs],
      };
      break;
    case 'REVOKE_SOURCE':
      state.sources[payload.id] ??= { revoked: false };
      state.sources[payload.id].revoked = true;
      break;
    case 'RESTORE_SOURCE':
      state.sources[payload.id] ??= { revoked: false };
      state.sources[payload.id].revoked = false;
      break;
    default:
      break;
  }
}

// Evaluate node status. Derived states: valid | degraded | unknown.
// Facts: valid | revoked | deleted. Missing node: unknown.
// `unknown` propagates as unknown; it is never counted as failed support.
export function evaluate(state, id) {
  const statusMemo = new Map();
  const supportMemo = new Map();

  function statusOf(nodeId) {
    if (statusMemo.has(nodeId)) return statusMemo.get(nodeId);
    let s;
    const f = state.facts[nodeId];
    if (f) {
      s = f.deleted ? 'deleted' : state.sources[f.source]?.revoked ? 'revoked' : 'valid';
    } else {
      const d = state.derived[nodeId];
      if (!d) {
        s = 'unknown';
      } else {
        const childStates = d.inputs.map(statusOf);
        if (childStates.some((c) => c === 'unknown')) {
          s = 'unknown';
        } else {
          const allValid = childStates.every((c) => c === 'valid');
          s = allValid && supportOf(nodeId) >= d.min ? 'valid' : 'degraded';
        }
      }
    }
    statusMemo.set(nodeId, s);
    return s;
  }

  function valueOf(nodeId) {
    const f = state.facts[nodeId];
    if (f) return f.value ?? 1;
    return supportOf(nodeId);
  }

  function supportOf(nodeId) {
    if (supportMemo.has(nodeId)) return supportMemo.get(nodeId);
    const d = state.derived[nodeId];
    if (!d) return 0;
    const validInputs = d.inputs.filter((i) => statusOf(i) === 'valid');
    const support =
      d.op === 'count'
        ? validInputs.length
        : validInputs.reduce((acc, i) => acc + valueOf(i), 0);
    supportMemo.set(nodeId, support);
    return support;
  }

  const status = statusOf(id);
  const result = { node: id, status };
  if (state.derived[id]) result.support = supportOf(id);
  return result;
}

export function evaluateAll(state) {
  const ids = [...Object.keys(state.facts), ...Object.keys(state.derived)];
  const out = {};
  for (const id of ids) out[id] = evaluate(state, id).status;
  return out;
}

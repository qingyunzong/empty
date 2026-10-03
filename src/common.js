'use strict';

const crypto = require('node:crypto');

const OPS = new Set(['sum', 'min', 'max', 'avg', 'concat']);

// Evaluate a derived node from its input values (already unblocked,
// ordered deterministically by input node id ascending).
// Returns { ok: true, value } or { ok: false, reason }.
function evaluate(op, values) {
  switch (op) {
    case 'sum': {
      let acc = 0;
      for (const v of values) {
        if (typeof v !== 'number') {
          return { ok: false, reason: `sum requires numeric inputs, got ${describe(v)}` };
        }
        acc += v;
      }
      return { ok: true, value: acc };
    }
    case 'min':
    case 'max':
    case 'avg': {
      if (values.length === 0) {
        return { ok: false, reason: `${op} requires at least one input` };
      }
      let acc = op === 'min' ? Infinity : op === 'max' ? -Infinity : 0;
      for (const v of values) {
        if (typeof v !== 'number') {
          return { ok: false, reason: `${op} requires numeric inputs, got ${describe(v)}` };
        }
        if (op === 'min') acc = Math.min(acc, v);
        else if (op === 'max') acc = Math.max(acc, v);
        else acc += v;
      }
      return { ok: true, value: op === 'avg' ? acc / values.length : acc };
    }
    case 'concat': {
      let acc = '';
      for (const v of values) {
        if (typeof v !== 'string') {
          return { ok: false, reason: `concat requires string inputs, got ${describe(v)}` };
        }
        acc += v;
      }
      return { ok: true, value: acc };
    }
    default:
      return { ok: false, reason: `unknown derive op ${op}` };
  }
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Deterministic JSON serialization: object keys sorted recursively.
function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

// Version certificate: sha256 over the canonical serialized state view
// ({ version, nodes, edges }). Pure function of the state, independent of
// the incremental path that produced it.
function certificate(view) {
  return crypto.createHash('sha256').update(canonicalize(view)).digest('hex');
}

module.exports = { OPS, evaluate, canonicalize, certificate };

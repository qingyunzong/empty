'use strict';

const { readFileSync } = require('node:fs');
const { Store } = require('./core');

// Extract a flat op list from a parsed history document.
// Accepted shapes:
//   [op, ...]                          plain op array
//   { ops: [op, ...] }                 wrapped op array
//   { branches: [ [op, ...], ... ] }   anonymous branches
//   { branches: { name: [op, ...] } }  named branches (key order = branch order)
function extractOps(doc) {
  if (Array.isArray(doc)) return doc.slice();
  if (doc && Array.isArray(doc.ops)) return doc.ops.slice();
  if (doc && doc.branches) {
    const out = [];
    if (Array.isArray(doc.branches)) {
      for (const branch of doc.branches) out.push(...branch);
    } else {
      for (const name of Object.keys(doc.branches)) out.push(...doc.branches[name]);
    }
    return out;
  }
  throw new Error('unrecognized history format');
}

function loadHistory(file, stdinText) {
  const text = file === '-' ? stdinText ?? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  return extractOps(JSON.parse(text));
}

// Deterministic total order: (clock, agentId, seq). seq preserves input
// position as a final tie-breaker so the result is always well-defined.
function totalOrder(ops) {
  return ops
    .map((op, seq) => ({ op, seq }))
    .sort((a, b) => {
      const ca = a.op.clock ?? 0;
      const cb = b.op.clock ?? 0;
      if (ca !== cb) return ca - cb;
      const aa = String(a.op.agentId ?? '');
      const ab = String(b.op.agentId ?? '');
      if (aa !== ab) return aa < ab ? -1 : 1;
      return a.seq - b.seq;
    })
    .map((x) => x.op);
}

// Replay ops in total order, settling incrementally after each op.
function replay(ops) {
  const store = new Store();
  for (const op of totalOrder(ops)) {
    store.applyOp(op);
    store.settle();
  }
  return store;
}

module.exports = { extractOps, loadHistory, totalOrder, replay };

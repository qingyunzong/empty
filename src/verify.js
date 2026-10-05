'use strict';
const { verify: verifyErr } = require('./errors.js');
const { keyOf } = require('./core.js');

// Recompute inventory from the op log and cross-check the ledger.
function verify(store) {
  store.requireInit();
  const state = store.loadState();
  const problems = [];
  const inv = {};
  for (const op of state.ops) {
    const k = keyOf(op.bin, op.item);
    inv[k] = (inv[k] || 0) + op.delta;
  }
  const keys = new Set([...Object.keys(inv), ...Object.keys(state.inventory)]);
  for (const k of keys) {
    if ((inv[k] || 0) !== (state.inventory[k] || 0)) {
      problems.push(`inventory[${k}]: ledger=${state.inventory[k] || 0} recomputed=${inv[k] || 0}`);
    }
  }
  for (const [k, v] of Object.entries(state.inventory)) {
    if (v < 0) problems.push(`inventory[${k}] is negative: ${v}`);
  }
  // vv is the contiguous received watermark per node (applied + pending).
  const perNode = new Map();
  for (const op of state.ops.concat(state.pending)) {
    if (!perNode.has(op.node)) perNode.set(op.node, []);
    perNode.get(op.node).push(op.seq);
  }
  for (const [node, seqs] of perNode) {
    seqs.sort((x, y) => x - y);
    const max = seqs[seqs.length - 1];
    const contiguous = seqs.every((s, i) => s === i + 1);
    if (!contiguous || (state.vv[node] || 0) !== max) {
      problems.push(`vv[${node}]=${state.vv[node] || 0} but received seqs ${seqs.join(',')}`);
    }
  }
  if (problems.length > 0) {
    throw verifyErr('VERIFY_MISMATCH', `ledger divergence: ${problems.join('; ')}`);
  }
  return { ok: true, node: state.nodeId, ops: state.ops.length, pending: state.pending.length, items: Object.keys(state.inventory).length };
}

module.exports = { verify };

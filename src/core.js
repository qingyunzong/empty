'use strict';

function keyOf(bin, item) {
  return bin + '|' + item;
}

// Apply ops (each {bin,item,delta,...}) to inventory in the given order.
// Integer deltas commute, so any order that can apply everything converges.
// An op that would drive a bin+item negative is deferred to `pending`
// (never a hard failure); pending is drained to a fixpoint after each pass.
function applyOps(inventory, ops) {
  const pending = [];
  const applied = [];
  const tryApply = (op) => {
    const k = keyOf(op.bin, op.item);
    const cur = inventory[k] || 0;
    if (cur + op.delta < 0) return false;
    inventory[k] = cur + op.delta;
    return true;
  };
  for (const op of ops) {
    if (tryApply(op)) applied.push(op);
    else pending.push(op);
  }
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      if (tryApply(pending[i])) {
        applied.push(pending[i]);
        pending.splice(i, 1);
        i--;
        progress = true;
      }
    }
  }
  return { applied, pending };
}

// Deterministic op ordering for merge: (node, seq).
function compareOps(a, b) {
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return a.seq - b.seq;
}

module.exports = { keyOf, applyOps, compareOps };

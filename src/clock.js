'use strict';

// Vector clocks: plain objects {nodeId: counter}.

function tick(clock, node) {
  const next = { ...clock };
  next[node] = (next[node] || 0) + 1;
  return next;
}

function mergeClocks(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v > (out[k] || 0)) out[k] = v;
  }
  return out;
}

// a <= b componentwise (missing component counts as 0)
function leq(a, b) {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] || 0) > (b[k] || 0)) return false;
  }
  return true;
}

// -1 a<b, 0 equal, 1 a>b, null concurrent
function compare(a, b) {
  const ab = leq(a, b);
  const ba = leq(b, a);
  if (ab && ba) return 0;
  if (ab) return -1;
  if (ba) return 1;
  return null;
}

module.exports = { tick, mergeClocks, leq, compare };

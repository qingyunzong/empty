import assert from 'node:assert/strict';
import { normalizeBranch, validateBranch } from '../src/event.js';

export function ev(id, ts, over = {}) {
  return {
    id,
    ts,
    source: 'test',
    type: 'evt',
    ackBy: null,
    note: '',
    deleted: false,
    dependsOn: [],
    ...over,
  };
}

export function branch(events) {
  const m = normalizeBranch(events);
  const v = validateBranch(m);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return m;
}

// Deterministic LCG for reproducible random graphs.
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

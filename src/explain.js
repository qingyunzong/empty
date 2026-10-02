import { clockSum } from './vectorClock.js';
import { badInput } from './errors.js';

// Replay the causal history leading to `target` from the version store.
// Ancestors are ordered deterministically by (clock sum, id), so replaying
// the same store always yields the same trace and the same final state.
export function explain(versions, targetId) {
  const store = Array.isArray(versions)
    ? new Map(versions.map((v) => [v.id, v]))
    : new Map(Object.values(versions).map((v) => [v.id, v]));
  const target = store.get(targetId);
  if (!target) throw badInput(`unknown target version: ${targetId}`);

  const ancestors = new Map();
  const stack = [target];
  while (stack.length > 0) {
    const v = stack.pop();
    if (ancestors.has(v.id)) continue;
    ancestors.set(v.id, v);
    for (const p of v.parents ?? []) {
      const parent = store.get(p);
      if (!parent) throw badInput(`version ${v.id} references missing parent ${p}`);
      stack.push(parent);
    }
  }

  const ordered = [...ancestors.values()].sort((a, b) => {
    const d = clockSum(a.clock) - clockSum(b.clock);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const steps = [];
  let state = null;
  for (const version of ordered) {
    if ((version.parents ?? []).length === 0) {
      state = { ...version.data };
      steps.push({ version: version.id, kind: 'base', clock: version.clock, data: { ...state } });
      continue;
    }
    const before = { ...state };
    for (const op of version.ops ?? []) {
      state[op.var] = op.to;
    }
    steps.push({
      version: version.id,
      kind: version.merged ? 'merge' : 'repair',
      clock: version.clock,
      ops: version.ops ?? [],
      before,
      after: { ...state },
    });
  }
  return { target: targetId, steps, final: state, matches: shallowEqual(state, target.data) };
}

function shallowEqual(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

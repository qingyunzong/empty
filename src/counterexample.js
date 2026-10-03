import { indexApprovals, permissionAt } from './interpreter.js';

function* combinations(arr, k) {
  const n = arr.length;
  if (k < 0 || k > n) return;
  if (k === 0) {
    yield [];
    return;
  }
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

function relevant(approvals, plant, attempt) {
  const chainKeys = new Set(plant.chainOf(attempt.kettle).map((c) => `${c.level}:${c.id}`));
  return approvals.filter(
    (a) =>
      a.kind !== 'revoke' &&
      chainKeys.has(`${a.level}:${a.target}`) &&
      (a.version === '*' || a.version === attempt.version) &&
      (a.operator == null || a.operator === '*' || a.operator === attempt.operator),
  );
}

function allows(subset, plant, attempt) {
  const idx = indexApprovals(subset);
  return (
    permissionAt(subset, idx, plant, attempt.kettle, attempt.version, attempt.operator, attempt.ts)
      .decision === 'allow'
  );
}

// Minimal subset of the given approvals whose permission layer alone would
// (wrongly) allow the attempt, ignoring forbidden-combination constraints.
// Exact for up to 16 relevant approvals, greedy fallback beyond that.
export function minimalAllowSet(recipes, approvals, attempt) {
  const plant = recipes.plant;
  const cand = relevant(approvals, plant, attempt);
  if (cand.length <= 16) {
    for (let size = 1; size <= cand.length; size++) {
      let best = null;
      for (const subset of combinations(cand, size)) {
        if (allows(subset, plant, attempt)) {
          const ids = subset.map((a) => a.id).sort();
          if (!best || ids.join('') < best.join('')) best = ids;
        }
      }
      if (best) return { size, set: best };
    }
    return null;
  }
  let current = [...cand];
  if (!allows(current, plant, attempt)) return null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of [...current]) {
      const trial = current.filter((x) => x !== a);
      if (allows(trial, plant, attempt)) {
        current = trial;
        changed = true;
      }
    }
  }
  return { size: current.length, set: current.map((a) => a.id).sort() };
}

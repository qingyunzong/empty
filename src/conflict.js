import { isLinearizable } from './checker.js';

// Deletion-based minimization over reference-closed subsets: removing a
// hold operation also removes every operation that references its holdId,
// so the conflict never "hides" behind dangling references. Returns a
// minimal subset of operation ids that is still not linearizable.
export function minimalConflict(ops) {
  const dependentsOf = new Map();
  for (const op of ops) {
    if (op.op === 'hold' && op.response.ok) {
      dependentsOf.set(
        op.id,
        ops.filter((other) => other.holdId === op.response.holdId).map((other) => other.id),
      );
    }
  }

  let current = [...ops];
  for (const op of [...current]) {
    if (current.length <= 1) break;
    const removed = new Set([op.id, ...(dependentsOf.get(op.id) ?? [])]);
    const trial = current.filter((candidate) => !removed.has(candidate.id));
    if (!isLinearizable(trial)) current = trial;
  }
  return current.map((op) => op.id);
}

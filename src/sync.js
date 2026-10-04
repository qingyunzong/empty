import { SyncError } from './errors.js';
import { compare, merge as mergeVector, deterministicWinner } from './version.js';

// A sync library (pack or feedback) is:
//   { node, vector, entries: [{seq, op, key, value, node, vector}] }
export function makeLibrary(node, entries) {
  let vector = {};
  for (const e of entries) vector = mergeVector(vector, e.vector ?? {});
  return { node, vector, entries };
}

// Merge two libraries. Same-key concurrent changes resolve deterministically
// (total order over vector+node+value); safety-critical keys never
// auto-resolve -- they go to `pending` and the merged library keeps the
// causally-dominant entry only.
export function mergeLibraries(libA, libB, registry) {
  const byKey = new Map();
  const pending = [];

  for (const entry of [...libA.entries, ...libB.entries]) {
    const cur = byKey.get(entry.key);
    if (!cur) { byKey.set(entry.key, entry); continue; }
    const rel = compare(entry.vector ?? {}, cur.vector ?? {});
    if (rel === 1 || rel === 0) {
      byKey.set(entry.key, entry);
    } else if (rel === -1) {
      // cur dominates, keep it
    } else {
      const def = registry?.get(entry.key);
      if (def?.safetyCritical) {
        pending.push({ key: entry.key, a: cur, b: entry });
        // Keep the deterministic winner as the held (unapplied) candidate so
        // the merge itself is still a pure function of its inputs.
        byKey.set(entry.key, deterministicWinner(cur, entry));
      } else {
        byKey.set(entry.key, deterministicWinner(cur, entry));
      }
    }
  }

  const entries = [...byKey.values()].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
  const vector = mergeVector(libA.vector ?? {}, libB.vector ?? {});
  return { node: 'merged', vector, entries, pending };
}

export function assertNoPending(merged) {
  if (merged.pending.length > 0) {
    throw new SyncError('CONFLICT',
      `safety-critical conflict requires manual resolution: ${merged.pending.map((p) => p.key).join(', ')}`,
      { pending: merged.pending.map((p) => p.key) });
  }
  return merged;
}

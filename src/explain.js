import { hash } from './canon.js';
import { DqError, HISTORY_CONFLICT } from './errors.js';
import { computeVersionId, replayEvents } from './history.js';

// Replay a version's causal history event-by-event and verify that the
// reconstructed data, vector clock and content id match the version itself.
// Any inconsistency (dangling parent, tampered data, bad clock, broken hash
// chain) raises HISTORY_CONFLICT.
export function explain(version) {
  const events = new Map();
  for (const e of version.history || []) {
    if (!events.has(e.id)) events.set(e.id, e);
  }
  const historyIds = [...events.keys()].sort();
  const expectId = computeVersionId(version.data, version.domains, version.vector, historyIds);
  if (expectId !== version.id) {
    throw new DqError(HISTORY_CONFLICT, 'version id does not match its content hash');
  }

  const all = [...events.values()];
  const replayed = replayEvents(all, version.id);
  if (hash(replayed.data) !== hash(version.data) || hash(replayed.vector) !== hash(version.vector)) {
    throw new DqError(HISTORY_CONFLICT, 'replayed state does not match version content');
  }

  // Build a human-readable, causally ordered step trace.
  const produced = new Set();
  const steps = [];
  let pending = all;
  while (pending.length > 0) {
    const next = [];
    for (const e of pending) {
      const ready = e.type === 'genesis'
        || (e.type === 'repair' && produced.has(e.parent))
        || (e.type === 'merge' && e.parents.every((p) => produced.has(p)));
      if (!ready) { next.push(e); continue; }
      const step = { event: e.id, type: e.type, versionId: e.versionId };
      if (e.type === 'repair') Object.assign(step, { node: e.node, diff: e.diff, cost: e.cost });
      if (e.type === 'merge') Object.assign(step, { parents: e.parents, resolved: e.resolved });
      steps.push(step);
      produced.add(e.versionId);
    }
    pending = next;
  }

  return { ok: true, verified: true, steps, replayed };
}

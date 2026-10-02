import { keyId, foldCandidates } from './state.js';
import { zeroCounts, accumulate, summarize } from './summarize.js';

// Brute-force reference implementation: derives window aggregates purely
// by replaying the raw event stream, with no incremental index involved.
// Tests cross-check the Fenwick path against this on every scenario.
export function bruteForceQuery(events, site, fromMs, toMs) {
  const undone = new Set(events.filter((e) => e.type === 'undo').map((e) => e.undoOf));
  const byKey = new Map();
  for (const e of events) {
    if (e.type === 'undo' || e.site !== site) continue;
    const id = keyId(e.site, e.time);
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push(e);
  }
  const counts = zeroCounts();
  for (const [id, candidates] of byKey) {
    const [, time] = JSON.parse(id);
    if (time < fromMs || time > toMs) continue;
    accumulate(counts, foldCandidates(candidates, undone));
  }
  return summarize(counts);
}

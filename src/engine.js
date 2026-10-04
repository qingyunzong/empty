// Ingest pipeline: validate -> dedup (idempotent) -> order within the
// out-of-order window -> durable commit -> causal conflict resolution.
import { Store, makeApplier, finalizeConflicts } from './store.js';
import { byTsId } from './event.js';

export const DEFAULT_WINDOW_MS = 5000;

// Recover from any crash, then re-derive causal conflicts so the committed
// state is complete even if the crash hit between commit and conflict fold.
export function recoverAndFinalize(store, { window = DEFAULT_WINDOW_MS } = {}) {
  const recovery = store.recover(makeApplier(store.state, { window }));
  const all = store.readLog().map((r) => r.event);
  const fin = finalizeConflicts(store.state, all);
  if (recovery.applied.length > 0 || fin.conflicts.length > 0 || Object.keys(store.state.pending).length > 0) {
    store.persistState();
  }
  return { recovery, conflicts: fin.conflicts, pending: Object.keys(store.state.pending).sort() };
}

// Ingest already-validated events into the store.
// Returns a report; never throws for VALIDATION-level problems.
export function ingestEvents(store, events, { window = DEFAULT_WINDOW_MS } = {}) {
  // 0. reconcile any previous crash before touching the log
  const { recovery } = recoverAndFinalize(store, { window });

  // 1. idempotent dedup against the index and within the batch
  const seen = new Set();
  const fresh = [];
  let duplicates = 0;
  for (const e of events) {
    if (store.has(e.id) || seen.has(e.id)) {
      duplicates++;
      continue;
    }
    seen.add(e.id);
    fresh.push(e);
  }
  store.state.stats.duplicates += duplicates;

  // 2. deterministic order inside the out-of-order window
  fresh.sort(byTsId);

  // 3. durable, exactly-once commit
  const apply = makeApplier(store.state, { window });
  const { applied, errors } = store.commit(fresh, apply);
  if (fresh.length === 0 && duplicates > 0) store.persistState();

  // 4. causal conflict resolution over the full event set
  const all = store.readLog().map((r) => r.event);
  const fin = finalizeConflicts(store.state, all);
  if (fin.conflicts.length > 0 || Object.keys(store.state.pending).length > 0 || fin.errors.length > 0) {
    store.persistState();
  }

  return {
    recovery,
    received: events.length,
    duplicates,
    applied,
    errors: [...errors, ...fin.errors],
    conflicts: fin.conflicts,
    pending: Object.keys(store.state.pending).sort(),
    watermark: store.state.watermark,
  };
}

export function openStore(dir) {
  return Store.fromEnv(dir);
}

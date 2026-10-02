import { canonicalOrder } from './interleave.js';
import { INITIAL_STATE, applyEvent } from './machine.js';

// Deterministic replayer: folds the canonical interleaving of the (possibly
// fault-injected) event log into the device state machine. Injection records
// are metadata, not device events, and are skipped.
export function replay(events, seed = 0) {
  let state = INITIAL_STATE;
  const ordered = canonicalOrder(
    events.filter((e) => e.kind !== 'injection'),
    seed,
  );
  const trace = [];
  for (const e of ordered) {
    const next = applyEvent(state, e.kind);
    trace.push({ id: e.id, kind: e.kind, from: state, to: next });
    state = next;
  }
  return { state, trace };
}

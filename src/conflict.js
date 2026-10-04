// Causal conflict resolution for lot hold/release.
//
// When lot events carry causal deps (payload.deps), the lot state is
// recomputed from the event *set* (deterministic, convergent):
//   - unknown ancestor or dependency cycle  -> status 'pending' (never failed)
//   - otherwise replay in causal-topological order
//   - concurrent manual release vs auto/manual hold among maximal events
//     -> safety-first: lot stays 'held', a conflict record is emitted
import { applyEvent, createLot, depsOf, indexById, causalMaxima, topoSort, unknownAncestors } from './statemachine.js';

const holdEffect = (e) =>
  e.kind === 'quality.hold' || (e.kind === 'quality.scan' && e.payload?.result === 'fail');
const releaseEffect = (e) => e.kind === 'quality.release';

export function hasCausalDeps(events) {
  return events.some((e) => depsOf(e).length > 0);
}

// Resolve one lot from its events. `allEventsMap` covers the whole store so
// that ancestors living on other lots/devices are known.
// Returns { lot, status, pending, conflict, errors }.
export function resolveLot(lotId, lotEvents, allEventsMap) {
  const sorted = [...lotEvents].sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
  const unknown = unknownAncestors(allEventsMap, lotEvents);
  if (unknown.length > 0) {
    return {
      lot: lotId,
      status: 'pending',
      pending: { reason: 'unknown-ancestor', ancestors: unknown.sort() },
      conflict: null,
      errors: [],
    };
  }
  const order = topoSort(allEventsMap, sorted);
  if (order === null) {
    return {
      lot: lotId,
      status: 'pending',
      pending: { reason: 'dependency-cycle', events: sorted.map((e) => e.id).sort() },
      conflict: null,
      errors: [],
    };
  }

  const tmp = { lots: {}, devices: {} };
  const errors = [];
  for (const e of order) {
    const r = applyEvent(tmp, e);
    if (!r.applied) errors.push(r.error);
  }
  const lot = tmp.lots[lotId] ?? createLot();

  // Concurrent hold/release among causal maxima -> safety-first hold.
  const locking = sorted.filter((e) => holdEffect(e) || releaseEffect(e));
  const maxima = causalMaxima(allEventsMap, locking);
  const maxHasHold = maxima.some(holdEffect);
  const maxHasRelease = maxima.some(releaseEffect);
  let conflict = null;
  if (maxHasHold && maxHasRelease) {
    conflict = {
      lot: lotId,
      reason: 'concurrent-hold-release',
      resolution: 'safety-first-hold',
      maximal: maxima.map((e) => ({ id: e.id, kind: e.kind, ts: e.ts, auto: e.payload?.auto === true || e.kind === 'quality.scan' })),
    };
    lot.status = 'held';
  }
  return { lot: lotId, status: lot.status, pending: null, conflict, errors, recomputed: lot };
}

// Re-resolve every lot that carries causal deps; mutate `state` in place.
// `allEvents` is the full event set of the store.
export function resolveConflicts(state, allEvents) {
  const byLot = new Map();
  for (const e of allEvents) {
    if (!byLot.has(e.lot)) byLot.set(e.lot, []);
    byLot.get(e.lot).push(e);
  }
  const map = indexById(allEvents);
  const conflicts = [];
  const errors = [];
  for (const [lotId, events] of byLot) {
    if (!hasCausalDeps(events)) continue;
    const r = resolveLot(lotId, events, map);
    state.lots[lotId] = r.recomputed ?? { ...createLot(), status: r.status };
    state.lots[lotId].status = r.status;
    if (r.pending) state.pending[lotId] = r.pending;
    else delete state.pending[lotId];
    if (r.conflict) conflicts.push(r.conflict);
    errors.push(...r.errors);
  }
  return { conflicts, errors };
}

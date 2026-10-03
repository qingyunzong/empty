// Counterexample search: the minimal set of revocations that flips a work
// order from "ok" to not-ok. Revocations are dated at the as-of date, so a
// measurement loses its proof exactly when every untainted certificate
// interval covering it is revoked. That yields the exact minimal set:
// the smallest set of untainted covering certificates over its measurements.
// bruteForceMinimalRevocations is the independent oracle used by the
// acceptance tests to cross-check the direct computation.

import { buildState, measurementStatus, workOrderStatus, coveringIntervals } from './engine.js';
import { formatDate, fromDays } from './dates.js';

export function workOrderStatusFor(state, records) {
  return workOrderStatus(records.map((r) => measurementStatus(state, r)));
}

// Returns { size, certs } of the minimal revocation set, or null when the
// work order is already not ok (nothing to disprove).
export function findMinimalRevocations(state, records) {
  if (workOrderStatusFor(state, records) !== 'ok') return null;
  let best = null;
  for (const r of records) {
    const ids = [
      ...new Set(
        coveringIntervals(state, r.instrument, r.date)
          .filter((x) => !x.interval.tainted)
          .map((x) => x.cert.id),
      ),
    ].sort();
    if (best === null || ids.length < best.length) best = ids;
  }
  return best === null ? null : { size: best.length, certs: best };
}

// Rebuilds the state with the given certificates revoked at day `day`.
export function applyRevocations(state, certIds, day) {
  const extra = certIds.map((id) => ({
    event: 'revoke',
    cert: id,
    date: formatDate(fromDays(day)),
  }));
  return buildState(state.model, [...state.rawEvents, ...extra], state.asOf);
}

export function* combinations(arr, k) {
  if (k <= 0 || k > arr.length) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === arr.length - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Exhaustive search over revocation subsets, minimal size first.
export function bruteForceMinimalRevocations(state, records, day) {
  const candidates = [...state.certs.values()]
    .filter((c) => !c.tainted)
    .map((c) => c.id)
    .sort();
  for (let k = 1; k <= candidates.length; k++) {
    for (const subset of combinations(candidates, k)) {
      const next = applyRevocations(state, subset, day);
      if (workOrderStatusFor(next, records) !== 'ok') return { size: k, certs: subset };
    }
  }
  return null;
}

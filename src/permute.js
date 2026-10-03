// Enumeration of legal arrival orderings (any permutation, since vehicle
// events may arrive out of order) and order-invariance verification.
// Limited to <= 6 events (720 orderings) as required by acceptance.

import { Fleet } from './fleet.js';

export function* permutations(arr) {
  const a = [...arr];
  yield* heap(a, a.length);
}

function* heap(a, n) {
  if (n === 1) {
    yield [...a];
    return;
  }
  for (let i = 0; i < n; i++) {
    yield* heap(a, n - 1);
    const j = n % 2 === 0 ? i : 0;
    [a[j], a[n - 1]] = [a[n - 1], a[j]];
  }
}

export function verifyOrderInvariance(config, events) {
  if (events.length > 6) {
    throw new Error(`enumeration limited to <= 6 events, got ${events.length}`);
  }
  let canonical = null;
  let checked = 0;
  for (const perm of permutations(events)) {
    const fleet = new Fleet(config);
    perm.forEach((ev, i) => fleet.ingest(ev, ev.arrivalTs ?? i + 1));
    const r = fleet.report();
    const fingerprint = JSON.stringify({
      timeline: r.timeline,
      bills: r.bills,
      unscheduled: r.unscheduled,
    });
    canonical ??= fingerprint;
    checked++;
    if (fingerprint !== canonical) {
      return { ok: false, checked, expected: canonical, actual: fingerprint };
    }
  }
  return { ok: true, checked };
}

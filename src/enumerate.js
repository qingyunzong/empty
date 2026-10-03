// Order-independence checker: for small event sets (<= 6 events by default,
// i.e. at most 720 orderings) enumerate every legal arrival order, replay each
// through a fresh engine and verify that the merged result (timeline, waiting
// queue, quotas, errors) is identical for every permutation.

import { FleetEngine } from './engine.js';

export function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

function canonical(report) {
  return JSON.stringify({
    timeline: report.timeline,
    waiting: report.waiting,
    quotas: report.quotas,
    errors: report.errors,
  });
}

export function checkOrderIndependence(config, events, { maxEvents = 6 } = {}) {
  if (events.length > maxEvents) {
    throw new Error(`enumeration is limited to ${maxEvents} events (got ${events.length})`);
  }
  let expected = null;
  let checked = 0;
  const mismatches = [];
  for (const perm of permutations(events)) {
    const engine = new FleetEngine(config);
    for (const event of perm) engine.ingest(event, event.ts);
    const result = canonical(engine.report());
    checked++;
    if (expected === null) {
      expected = result;
    } else if (result !== expected) {
      mismatches.push({ order: perm.map((e) => e.seq) });
    }
  }
  return { ok: mismatches.length === 0, checked, mismatches };
}

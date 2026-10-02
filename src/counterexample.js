import { analyze } from './analyze.js';
import { validateEvents } from './schema.js';

function labelAt(events, at, params) {
  let cert;
  try {
    cert = analyze(events, params);
  } catch {
    return null;
  }
  return cert.timeline.find((iv) => iv.start <= at && at < iv.end) ?? null;
}

const isUnplanned = (label) => label !== null && label.downtime === true && label.planned === false;
const isUnplannedAt = (events, at, params) => isUnplanned(labelAt(events, at, params));

const brief = (label) =>
  label === null ? { state: 'none' } : { state: label.state, planned: label.planned, rule: label.rule };

// Shrink every event's [start, end) as far as possible while the disputed
// point stays unplanned. Binary search per boundary (integer ms).
function shrinkEvents(events, at, params) {
  const current = events.map((e) => ({ ...e }));
  for (const e of current) {
    let lo = e.start;
    let hi = e.end - 1;
    let best = lo;
    while (lo <= hi) {
      const mid = lo + ((hi - lo) >> 1);
      e.start = mid;
      if (isUnplannedAt(current, at, params)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    e.start = best;

    lo = e.start + 1;
    hi = e.end;
    let bestEnd = hi;
    while (lo <= hi) {
      const mid = lo + ((hi - lo) >> 1);
      e.end = mid;
      if (isUnplannedAt(current, at, params)) {
        bestEnd = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    e.end = bestEnd;
  }
  return current;
}

// Given a disputed timestamp whose interval is judged unplanned, produce the
// minimal event subset (by deletion, then boundary shrinking) that still
// reproduces the judgment, plus witnesses showing which delete/shrink flips
// the interval back to planned.
export function minimizeMisjudgment(rawEvents, at, paramOverrides = {}) {
  if (!Number.isSafeInteger(at)) {
    return { kind: 'counterexample', at, found: false, reason: 'at must be a safe integer (epoch ms)' };
  }
  const base = analyze(rawEvents, paramOverrides);
  const target = base.timeline.find((iv) => iv.start <= at && at < iv.end);
  if (!target) {
    return { kind: 'counterexample', at, found: false, reason: 'no interval covers the disputed timestamp' };
  }
  if (!isUnplanned(target)) {
    return {
      kind: 'counterexample',
      at,
      found: false,
      reason: 'interval is not judged unplanned',
      target: brief(target),
    };
  }
  const params = base.params;

  // Phase 1: greedy 1-minimal deletion.
  let current = validateEvents(rawEvents);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of [...current]) {
      const trial = current.filter((x) => x.id !== e.id);
      if (isUnplannedAt(trial, at, params)) {
        current = trial;
        changed = true;
      }
    }
  }

  // Phase 2: shrink surviving events toward the disputed point.
  current = shrinkEvents(current, at, params);

  // Witnesses: single deletions / 1ms shrinks that flip the label to planned.
  const witnesses = [];
  for (const e of current) {
    const without = current.filter((x) => x.id !== e.id);
    const deleted = labelAt(without, at, params);
    if (!isUnplanned(deleted)) {
      witnesses.push({ kind: 'delete-event', eventId: e.id, resulting: brief(deleted) });
    }
    for (const [field, delta] of [['start', 1], ['end', -1]]) {
      const nudged = current.map((x) => (x.id === e.id ? { ...x, [field]: x[field] + delta } : x));
      const moved = nudged.find((x) => x.id === e.id);
      if (moved.end <= moved.start) continue;
      const shrunk = labelAt(nudged, at, params);
      if (!isUnplanned(shrunk)) {
        witnesses.push({
          kind: 'shrink-event',
          eventId: e.id,
          to: { start: moved.start, end: moved.end },
          resulting: brief(shrunk),
        });
      }
    }
  }

  const minimalLabel = labelAt(current, at, params);
  return {
    kind: 'counterexample',
    at,
    found: true,
    original: {
      state: target.state,
      rule: target.rule,
      winnerEventIds: target.winnerEventIds,
      spanDurationMs: target.spanDurationMs,
      thresholdMs: target.thresholdMs,
    },
    minimalEvents: current,
    minimalLabel: brief(minimalLabel),
    witnesses,
    verified1Minimal: current.every((e) =>
      witnesses.some((w) => w.kind === 'delete-event' && w.eventId === e.id),
    ),
  };
}

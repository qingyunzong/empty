import { inAnyInterval, coveredBy } from './intervals.js';

// Reference implementation used to cross-check the engine in tests.
// It independently enumerates every period and, for each period, the set of
// heartbeats falling inside its effective (downtime-subtracted) window.
//
// `rule` is a plain object: { periodStart, periodLength, expectedOffset,
//   grace, mergeGap }
// `tableEntries` is null or an array of { start, end, offset }.
// Returns the merged alarm list in the same shape as the engine.
export function referenceAlarms(rule, tableEntries, heartbeatTimes, downtimes, cutoff) {
  // Step 1: per-period heartbeat sets.
  const periods = [];
  for (let k = 0; ; k++) {
    const base = rule.periodStart + k * rule.periodLength + rule.expectedOffset;
    if (base >= cutoff) break;
    let offset = 0;
    if (tableEntries) {
      const entry = tableEntries.find((e) => base >= e.start && base < e.end);
      if (!entry) {
        const err = new Error(`offset table gap at time ${base}`);
        err.code = 'OFFSET_GAP';
        throw err;
      }
      offset = entry.offset;
    }
    const start = base + offset;
    const end = start + rule.grace;
    if (end > cutoff) break;
    const beats = heartbeatTimes.filter(
      (t) => t >= start && t <= end && !inAnyInterval(downtimes, t),
    );
    periods.push({ k, start, end, exempt: coveredBy(downtimes, start, end), beats });
  }

  // Step 2: consecutive missed periods become alarm intervals.
  const alarms = [];
  let run = null;
  const flush = (open) => {
    if (!run) return;
    alarms.push({
      start: run.start,
      end: open ? cutoff : run.end,
      status: open ? 'OPEN' : 'CLOSED',
      missedPeriods: run.missed,
    });
    run = null;
  };
  for (const p of periods) {
    if (p.exempt || p.beats.length > 0) {
      flush(false);
      continue;
    }
    if (!run) run = { start: p.start, end: p.end, missed: [p.k] };
    else {
      run.end = p.end;
      run.missed.push(p.k);
    }
  }
  flush(true);

  // Step 3: merge adjacent alarms separated by at most mergeGap.
  const merged = [];
  for (const a of alarms) {
    const last = merged[merged.length - 1];
    if (last && a.start - last.end <= rule.mergeGap) {
      last.end = a.end;
      last.status = a.status;
      last.missedPeriods = last.missedPeriods.concat(a.missedPeriods);
    } else {
      merged.push({ ...a, missedPeriods: [...a.missedPeriods] });
    }
  }
  return merged;
}

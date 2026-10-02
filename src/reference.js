// Reference implementation: an independent full scan over all log records
// that rebuilds bitemporal intervals from scratch. It shares no state with
// the incremental engine and is used to cross-check it (tests + `verify`).

import { parseTime } from './validate.js';
import { dayOf } from './engine.js';

// Flatten log records into internal events. Every batch event gets an
// arrival seq (including events of later-undone transactions, matching the
// engine); undo records only mark their target transaction as inactive.
export function activeEvents(records) {
  const undone = new Set(
    records.filter((r) => r.kind === 'undo').map((r) => r.undo_tx_id),
  );
  const events = [];
  let seq = 0;
  for (const record of records) {
    if (record.kind !== 'batch') continue;
    for (const raw of record.events) {
      events.push({
        id: raw.id,
        equipment: raw.equipment,
        validMs: parseTime(raw.valid_time, 'valid_time'),
        state: raw.state,
        txId: raw.tx_id,
        txMs: parseTime(raw.tx_time, 'tx_time'),
        seq: seq++,
        undone: undone.has(raw.tx_id),
      });
    }
  }
  return events.filter((e) => !e.undone);
}

// Bitemporal intervals for one equipment as known at transaction time
// `txMs`: sorted [from, to) spans, each carrying a state. Corrections
// (same valid_time, later tx_time) replace the earlier point.
export function buildIntervals(events, equipment, txMs = Infinity) {
  const points = events
    .filter((e) => e.equipment === equipment && e.txMs <= txMs)
    .sort((a, b) => a.validMs - b.validMs || a.txMs - b.txMs || a.seq - b.seq);
  const collapsed = [];
  for (const point of points) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.validMs === point.validMs) collapsed[collapsed.length - 1] = point;
    else collapsed.push(point);
  }
  return collapsed.map((point, i) => ({
    from: point.validMs,
    to: i + 1 < collapsed.length ? collapsed[i + 1].validMs : Infinity,
    state: point.state,
  }));
}

export function asOf(events, equipment, validMs, txMs = Infinity) {
  let state = null;
  for (const interval of buildIntervals(events, equipment, txMs)) {
    if (interval.from <= validMs) state = interval.state;
    else break;
  }
  return state;
}

// Events effective in the current view: per (equipment, valid_time) the one
// with the greatest tx_time (arrival seq breaks ties).
export function effectiveEvents(events) {
  const map = new Map();
  for (const event of events) {
    const key = `${event.equipment} ${event.validMs}`;
    const current = map.get(key);
    if (
      !current ||
      event.txMs > current.txMs ||
      (event.txMs === current.txMs && event.seq > current.seq)
    ) {
      map.set(key, event);
    }
  }
  return [...map.values()];
}

export function dailyCounts(events) {
  const counts = {};
  for (const event of effectiveEvents(events)) {
    const day = dayOf(event.validMs);
    const byDay = (counts[event.equipment] ??= {});
    const entry = (byDay[day] ??= { up: 0, down: 0 });
    entry[event.state] += 1;
  }
  return counts;
}

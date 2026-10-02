import { HORIZON_MS, WATERMARK_DELAY_MS, WINDOW_MS } from './constants.js';
import { schedule } from './scheduler.js';

// Streaming-style event-time pipeline over the JSONL input (processed in file
// order). Watermark = max event time seen - 2min. The 8h horizon is split into
// 1h emission windows; a window is emitted once the watermark passes its end.
// Late but retractable data (order/maint adds) is applied and incrementally
// corrects already-emitted windows; late non-retractable data (retract events)
// goes to late.log.
export function runPipeline(events) {
  const orders = new Map();
  const maints = new Map();
  const corrections = [];
  const late = [];
  const horizonStart = events.length ? events[0].eventTs : 0;
  const numWindows = HORIZON_MS / WINDOW_MS;
  const emitted = new Array(numWindows).fill(null);
  let maxEventTs = null;
  let best = schedule([], [], horizonStart);
  let corrSeq = 0;

  const windowContent = (entries, i) =>
    entries
      .filter((e) => e.start >= horizonStart + i * WINDOW_MS && e.start < horizonStart + (i + 1) * WINDOW_MS)
      .map((e) => ({ job: e.job, mold: e.mold, start: e.start, end: e.end }));

  const emitAndDiff = (trigger) => {
    const entries = best.sequences[0];
    const watermark = maxEventTs === null ? null : maxEventTs - WATERMARK_DELAY_MS;
    for (let i = 0; i < numWindows; i++) {
      const content = windowContent(entries, i);
      const key = JSON.stringify(content);
      const windowEnd = horizonStart + (i + 1) * WINDOW_MS;
      if (emitted[i] === null) {
        if (watermark !== null && windowEnd <= watermark) emitted[i] = key;
      } else if (emitted[i] !== key) {
        corrections.push({
          seq: ++corrSeq,
          window: { index: i, start: horizonStart + i * WINDOW_MS, end: windowEnd },
          trigger,
          before: JSON.parse(emitted[i]),
          after: content,
        });
        emitted[i] = key;
      }
    }
  };

  for (const ev of events) {
    const watermark = maxEventTs === null ? -Infinity : maxEventTs - WATERMARK_DELAY_MS;
    const isLate = ev.eventTs < watermark;
    if (isLate && ev.type === 'retract') {
      late.push({ eventTs: ev.eventTs, reason: 'LATE_NON_RETRACTABLE', event: ev });
      continue;
    }
    if (ev.type === 'order') orders.set(ev.job, ev);
    else if (ev.type === 'maint') {
      if (ev.id === undefined) ev.id = `${ev.machine}:${ev.start}:${ev.end}`;
      maints.set(ev.id, ev);
    }
    else if (ev.kind === 'order') orders.delete(ev.id);
    else maints.delete(ev.id);
    if (!isLate) maxEventTs = maxEventTs === null ? ev.eventTs : Math.max(maxEventTs, ev.eventTs);
    best = schedule([...orders.values()], [...maints.values()], horizonStart);
    emitAndDiff({
      type: ev.type,
      id: ev.type === 'order' ? ev.job : ev.id,
      eventTs: ev.eventTs,
      late: isLate,
    });
  }

  // Final emission: close all remaining windows with the terminal schedule.
  const finalEntries = best.sequences[0];
  for (let i = 0; i < numWindows; i++) {
    if (emitted[i] === null) emitted[i] = JSON.stringify(windowContent(finalEntries, i));
  }

  return {
    horizonStart,
    horizonEnd: horizonStart + HORIZON_MS,
    watermark: maxEventTs === null ? null : maxEventTs - WATERMARK_DELAY_MS,
    best,
    corrections,
    late,
  };
}

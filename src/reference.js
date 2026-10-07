import { WINDOW_SECONDS, windowStart } from './windows.js';

// Reference algorithm: independently sort the device's events and scan every
// window second by second. Used to cross-check the incremental engine.
export function referenceWindows(events, device, from, to) {
  const sorted = events
    .filter((e) => e.device === device)
    .slice()
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows = [];
  for (let w = windowStart(from); w < to; w += WINDOW_SECONDS) {
    let up = 0;
    let down = 0;
    let idx = 0;
    let state = null;
    for (let s = w; s < w + WINDOW_SECONDS; s += 1) {
      while (idx < sorted.length && sorted[idx].ts <= s) {
        state = sorted[idx].state;
        idx += 1;
      }
      if (state === 'up') up += 1;
      else if (state === 'down') down += 1;
    }
    const unknown = WINDOW_SECONDS - up - down;
    rows.push({
      device,
      windowStart: w,
      windowEnd: w + WINDOW_SECONDS,
      uptime: unknown === WINDOW_SECONDS ? null : up,
      downtime: unknown === WINDOW_SECONDS ? null : down,
      unknown,
    });
  }
  return rows;
}

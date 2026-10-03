'use strict';

// Reference algorithm: independently sorts the events and scans every window
// second by second. Used to cross-check the incremental aggregator.

const { WINDOW_SECONDS, windowStart } = require('./aggregator');

function referenceWindows(events, device, from, to) {
  const evs = events
    .filter((e) => e.device === device)
    .slice()
    .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows = [];
  for (let w = windowStart(from); w < to; w += WINDOW_SECONDS) {
    let up = 0;
    let down = 0;
    let unknown = 0;
    let idx = 0;
    let state = null;
    while (idx < evs.length && evs[idx].ts <= w) {
      state = evs[idx].state;
      idx += 1;
    }
    for (let s = w; s < w + WINDOW_SECONDS; s += 1) {
      while (idx < evs.length && evs[idx].ts <= s) {
        state = evs[idx].state;
        idx += 1;
      }
      if (state === 'up') up += 1;
      else if (state === 'down') down += 1;
      else unknown += 1;
    }
    if (up + down === 0) {
      rows.push({ device, window: w, uptime: null, downtime: null, unknown: WINDOW_SECONDS });
    } else {
      rows.push({ device, window: w, uptime: up, downtime: down, unknown });
    }
  }
  return rows;
}

module.exports = { referenceWindows };

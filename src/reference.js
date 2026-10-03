'use strict';

const { scopeAt, sortEvents } = require('./merge');

// Reference algorithm: enumerates every millisecond of the observation
// window, computes the device state and merge scope at that millisecond, and
// groups consecutive milliseconds with equal (state, scope). Used to
// cross-check the optimized boundary-sweep implementation.
function referenceMerged({ events, periods, silences, obsStart, cutoff }) {
  const sorted = sortEvents(events);
  let ptr = 0;
  let state = null;
  while (ptr < sorted.length && sorted[ptr].utcMs <= obsStart) {
    state = sorted[ptr].state;
    ptr++;
  }
  const intervals = [];
  let current = null;
  for (let t = obsStart; t < cutoff; t++) {
    while (ptr < sorted.length && sorted[ptr].utcMs <= t) {
      state = sorted[ptr].state;
      ptr++;
    }
    if (state === null) {
      current = null;
      continue;
    }
    const scope = scopeAt(periods, silences, t);
    if (current && current.state === state && current.scope === scope) {
      current.endUtcMs = t + 1;
    } else {
      current = { state, scope, startUtcMs: t, endUtcMs: t + 1 };
      intervals.push(current);
    }
  }
  return intervals;
}

module.exports = { referenceMerged };

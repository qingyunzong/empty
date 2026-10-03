'use strict';

// Independent brute-force reference implementation used only by tests.
// It expands the timeline minute-by-minute instead of using binary search
// or candidate arithmetic, so it cross-checks src/convert.js.

const { MS_PER_MIN, civilToMs, parseLocalIso } = require('./time');

// Offset at utcMs by a plain linear scan over transitions (no binary search).
function refOffsetAt(table, zoneName, utcMs) {
  const { transitions } = table.zones.get(zoneName);
  let offset = transitions[0].offsetMinutes;
  for (let i = 1; i < transitions.length; i++) {
    if (transitions[i].utcMs <= utcMs) offset = transitions[i].offsetMinutes;
    else break;
  }
  return offset;
}

function refUtcToLocal(table, zoneName, utcMs) {
  const offsetMinutes = refOffsetAt(table, zoneName, utcMs);
  return utcMs + offsetMinutes * MS_PER_MIN;
}

// All UTC instants mapping to the local timestamp, found by expanding every
// UTC minute in a +-24h window around the naive interpretation.
function refLocalToUtcCandidates(table, zoneName, localIso) {
  const localMs = civilToMs(parseLocalIso(localIso));
  const found = [];
  for (let u = localMs - 24 * 3600000; u <= localMs + 24 * 3600000; u += MS_PER_MIN) {
    if (refUtcToLocal(table, zoneName, u) === localMs) found.push(u);
  }
  return found;
}

module.exports = { refOffsetAt, refUtcToLocal, refLocalToUtcCandidates };

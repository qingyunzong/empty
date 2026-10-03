'use strict';

// Scope key for a millisecond t: inside a maintenance silence the scope is the
// silence interval (so adjacent periods in the same silence merge); otherwise
// it is the period window containing t.
function periodScopeAt(periods, t) {
  if (!periods) return 'ALL';
  if (t < periods.startMs) return 'PRE';
  if (t >= periods.endMs) return 'POST';
  return 'P' + Math.floor((t - periods.startMs) / periods.durationMs);
}

function silenceIndexAt(silences, t) {
  for (let i = 0; i < silences.length; i++) {
    if (t >= silences[i].startMs && t < silences[i].endMs) return i;
  }
  return -1;
}

function scopeAt(periods, silences, t) {
  const s = silenceIndexAt(silences, t);
  return s >= 0 ? 'S' + s : periodScopeAt(periods, t);
}

function sortEvents(events) {
  return [...events].sort((a, b) =>
    a.utcMs - b.utcMs || a.version - b.version || a.seq - b.seq
  );
}

// Optimized merge: sweeps segment boundaries (event instants, period window
// edges, silence edges, observation edges) instead of enumerating every ms.
// events must be effective (corrections applied, version filtered) and carry
// { utcMs, state, version, seq }. Returns raw intervals
// [{ state, scope, startUtcMs, endUtcMs }] clipped to [obsStart, cutoff).
function computeMerged({ events, periods, silences, obsStart, cutoff }) {
  const sorted = sortEvents(events);
  const bounds = new Set([obsStart, cutoff]);
  for (const e of sorted) {
    if (e.utcMs > obsStart && e.utcMs < cutoff) bounds.add(e.utcMs);
  }
  if (periods) {
    const { startMs, durationMs, endMs } = periods;
    let n = Math.max(0, Math.ceil((obsStart + 1 - startMs) / durationMs));
    for (let b = startMs + n * durationMs; b < endMs && b < cutoff; b += durationMs) {
      bounds.add(b);
    }
    if (endMs > obsStart && endMs < cutoff) bounds.add(endMs);
  }
  for (const s of silences) {
    if (s.startMs > obsStart && s.startMs < cutoff) bounds.add(s.startMs);
    if (s.endMs > obsStart && s.endMs < cutoff) bounds.add(s.endMs);
  }
  const points = [...bounds].sort((a, b) => a - b);

  let ptr = 0;
  let state = null;
  while (ptr < sorted.length && sorted[ptr].utcMs <= obsStart) {
    state = sorted[ptr].state;
    ptr++;
  }

  const intervals = [];
  let current = null;
  for (let i = 0; i < points.length - 1; i++) {
    const b = points[i];
    if (i > 0) {
      while (ptr < sorted.length && sorted[ptr].utcMs <= b) {
        state = sorted[ptr].state;
        ptr++;
      }
    }
    if (state === null) {
      current = null;
      continue;
    }
    const scope = scopeAt(periods, silences, b);
    const end = points[i + 1];
    if (current && current.state === state && current.scope === scope) {
      current.endUtcMs = end;
    } else {
      current = { state, scope, startUtcMs: b, endUtcMs: end };
      intervals.push(current);
    }
  }
  return intervals;
}

module.exports = { computeMerged, scopeAt, periodScopeAt, silenceIndexAt, sortEvents };

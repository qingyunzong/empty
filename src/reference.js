'use strict';

const { DomainError, toIso, normalizeEvent, normalizeShift } = require('./validate');

function compareIntervals(a, b) {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.endMs !== b.endMs) return a.endMs - b.endMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

// Brute-force reference: sort all intervals, verify non-overlap, merge adjacent
// same-state intervals into sessions, compute shift metrics from scratch.
function fullRecompute(rawEvents, rawShifts) {
  const shifts = rawShifts.map(normalizeShift).sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
  const intervals = rawEvents.map((e, i) => normalizeEvent(e, e && e.id !== undefined ? String(e.id) : `e${i + 1}`));
  const seen = new Set();
  for (const iv of intervals) {
    if (seen.has(iv.id)) throw new DomainError('DUPLICATE_ID', `duplicate event id "${iv.id}"`, { id: iv.id });
    seen.add(iv.id);
  }
  intervals.sort(compareIntervals);
  for (let i = 1; i < intervals.length; i += 1) {
    if (intervals[i].startMs < intervals[i - 1].endMs) {
      throw new DomainError('OVERLAP', `event "${intervals[i].id}" overlaps existing event "${intervals[i - 1].id}"`, {
        id: intervals[i].id,
        overlaps: intervals[i - 1].id,
      });
    }
  }

  const sessions = [];
  for (const iv of intervals) {
    const last = sessions[sessions.length - 1];
    if (last && last.state === iv.state && last.endMs === iv.startMs) {
      last.endMs = iv.endMs;
      last.sourceIds.push(iv.id);
    } else {
      sessions.push({ state: iv.state, startMs: iv.startMs, endMs: iv.endMs, sourceIds: [iv.id] });
    }
  }

  const metrics = shifts.map((shift) => {
    let runMs = 0;
    let failMs = 0;
    for (const s of sessions) {
      if (s.state !== 'RUN' && s.state !== 'FAIL') continue;
      const overlap = Math.min(s.endMs, shift.endMs) - Math.max(s.startMs, shift.startMs);
      if (overlap <= 0) continue;
      if (s.state === 'RUN') runMs += overlap;
      else failMs += overlap;
    }
    const span = shift.endMs - shift.startMs;
    return {
      id: shift.id,
      start: toIso(shift.startMs),
      end: toIso(shift.endMs),
      runMs,
      failMs,
      availability: span > 0 ? round6(runMs / span) : null,
    };
  });

  return {
    sessions: sessions.map((s) => ({
      state: s.state,
      start: toIso(s.startMs),
      end: toIso(s.endMs),
      durationMs: s.endMs - s.startMs,
      sources: s.sourceIds.slice(),
    })),
    shifts: metrics,
  };
}

module.exports = { fullRecompute };

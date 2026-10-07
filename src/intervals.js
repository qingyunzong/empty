'use strict';

class CalendarError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
    if (details) this.details = details;
  }
}

// All intervals are half-open [start, end) in epoch milliseconds.
function assertInterval(start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new CalendarError('INVALID_INTERVAL', 'interval bounds must be safe integers (ms)', { start, end });
  }
  if (end < start) {
    throw new CalendarError('INVERTED_INTERVAL', `interval end ${end} is before start ${start}`, { start, end });
  }
  if (end === start) {
    throw new CalendarError('ZERO_DURATION', `interval has zero duration at ${start}`, { start, end });
  }
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Returns {start, end} of the overlap, or null when disjoint/adjacent.
function intersection(aStart, aEnd, bStart, bEnd) {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return s < e ? { start: s, end: e } : null;
}

// Subtract a list of half-open intervals (cutters) from [start, end).
function subtractInterval(start, end, cutters) {
  let pieces = [{ start, end }];
  for (const c of cutters) {
    const next = [];
    for (const p of pieces) {
      if (!overlaps(p.start, p.end, c.start, c.end)) {
        next.push(p);
        continue;
      }
      if (c.start > p.start) next.push({ start: p.start, end: c.start });
      if (c.end < p.end) next.push({ start: c.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

module.exports = { CalendarError, assertInterval, overlaps, intersection, subtractInterval };

'use strict';

const { CalendarError, assertInterval, overlaps, subtractInterval } = require('./intervals');
const { MINUTE_MS } = require('./timezone');

const DAY_MS = 86400000;

function parseTimeOfDay(value) {
  if (Number.isSafeInteger(value)) {
    if (value < 0 || value >= DAY_MS) {
      throw new CalendarError('INVALID_SHIFT', `timeOfDay ms out of range: ${value}`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!m) throw new CalendarError('INVALID_SHIFT', `bad timeOfDay: ${value}`);
    const h = Number(m[1]);
    const min = Number(m[2]);
    const s = m[3] === undefined ? 0 : Number(m[3]);
    if (h > 23 || min > 59 || s > 59) {
      throw new CalendarError('INVALID_SHIFT', `bad timeOfDay: ${value}`);
    }
    return ((h * 60 + min) * 60 + s) * 1000;
  }
  throw new CalendarError('INVALID_SHIFT', `bad timeOfDay: ${String(value)}`);
}

// A recurring shift:
//   { tz, freq: 'daily' | 'weekly', timeOfDay: 'HH:MM' | ms, durationMinutes,
//     weekdays?: [0..6] (0=Sunday, weekly only, default all),
//     fromLocal?: ms, untilLocal?: ms }
// Downtime exceptions and handover intervals are plain half-open utc intervals.
class Calendar {
  constructor(tzTable, { shifts = [], exceptions = [], handovers = [] } = {}) {
    this.tz = tzTable;
    this.shifts = shifts.map((s) => this.#normalizeShift(s));
    this.exceptions = exceptions.map((e) => this.#normalizeInterval(e, 'exception'));
    this.handovers = handovers.map((h) => this.#normalizeInterval(h, 'handover'));
  }

  #normalizeShift(s) {
    if (!s || typeof s !== 'object') throw new CalendarError('INVALID_SHIFT', 'shift must be an object');
    if (s.freq !== 'daily' && s.freq !== 'weekly') {
      throw new CalendarError('INVALID_SHIFT', `unsupported freq: ${s.freq}`);
    }
    if (!Number.isSafeInteger(s.durationMinutes)) {
      throw new CalendarError('INVALID_SHIFT', 'durationMinutes must be an integer');
    }
    if (s.durationMinutes < 0) {
      throw new CalendarError('INVERTED_INTERVAL', `negative durationMinutes: ${s.durationMinutes}`);
    }
    if (s.durationMinutes === 0) {
      throw new CalendarError('ZERO_DURATION', 'shift durationMinutes must be > 0');
    }
    const out = {
      id: s.id ?? null,
      tz: s.tz,
      freq: s.freq,
      timeOfDayMs: parseTimeOfDay(s.timeOfDay ?? 0),
      durationMinutes: s.durationMinutes,
      weekdays: s.weekdays ?? null,
      fromLocal: s.fromLocal ?? null,
      untilLocal: s.untilLocal ?? null,
    };
    this.tz.eras(out.tz); // validates zone exists
    if (out.weekdays) {
      for (const d of out.weekdays) {
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          throw new CalendarError('INVALID_SHIFT', `bad weekday: ${d}`);
        }
      }
    }
    if (out.fromLocal !== null && out.untilLocal !== null && out.untilLocal <= out.fromLocal) {
      throw new CalendarError('INVERTED_INTERVAL', 'shift untilLocal must be after fromLocal');
    }
    return out;
  }

  #normalizeInterval(iv, kind) {
    if (!iv || typeof iv !== 'object') throw new CalendarError('INVALID_INTERVAL', `${kind} must be an object`);
    assertInterval(iv.start, iv.end);
    return { id: iv.id ?? null, start: iv.start, end: iv.end, kind };
  }

  // Expand one shift into concrete half-open utc occurrences overlapping
  // the window [windowStart, windowEnd).
  expandShift(shift, windowStart, windowEnd) {
    assertInterval(windowStart, windowEnd);
    const s = shift.timeOfDayMs === undefined ? this.#normalizeShift(shift) : shift;
    const durationMs = s.durationMinutes * MINUTE_MS;
    // Local-day range that could produce occurrences touching the window.
    // Pad by one day on each side to be safe across era switches.
    const localStart = this.tz.utcToLocal(s.tz, windowStart) - durationMs;
    const localEnd = this.tz.utcToLocal(s.tz, windowEnd - 1) + durationMs;
    const firstDay = Math.floor(localStart / DAY_MS) - 1;
    const lastDay = Math.floor(localEnd / DAY_MS) + 1;
    const out = [];
    for (let day = firstDay; day <= lastDay; day++) {
      if (s.freq === 'weekly' && s.weekdays) {
        const wd = (((day + 4) % 7) + 7) % 7; // epoch day 0 = Thursday
        if (!s.weekdays.includes(wd)) continue;
      }
      const localMs = day * DAY_MS + s.timeOfDayMs;
      if (s.fromLocal !== null && localMs < s.fromLocal) continue;
      if (s.untilLocal !== null && localMs >= s.untilLocal) continue;
      let utcStart;
      try {
        utcStart = this.tz.localToUtc(s.tz, localMs);
      } catch (err) {
        if (err instanceof CalendarError && err.code === 'INVALID_LOCAL_TIME') continue; // skipped by a gap
        throw err;
      }
      const utcEnd = utcStart + durationMs;
      if (overlaps(utcStart, utcEnd, windowStart, windowEnd)) {
        out.push({ start: utcStart, end: utcEnd, shiftId: s.id, kind: 'shift' });
      }
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }

  // All shift occurrences in the window.
  shiftIntervals(windowStart, windowEnd) {
    const out = [];
    for (const s of this.shifts) out.push(...this.expandShift(s, windowStart, windowEnd));
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }

  // Effective busy intervals: shift occurrences minus downtime exceptions,
  // plus half-open handover intervals, all clipped to the window.
  busyIntervals(windowStart, windowEnd) {
    assertInterval(windowStart, windowEnd);
    const out = [];
    for (const occ of this.shiftIntervals(windowStart, windowEnd)) {
      for (const piece of subtractInterval(occ.start, occ.end, this.exceptions)) {
        const start = Math.max(piece.start, windowStart);
        const end = Math.min(piece.end, windowEnd);
        if (start < end) out.push({ start, end, shiftId: occ.shiftId, kind: 'shift' });
      }
    }
    for (const h of this.handovers) {
      if (overlaps(h.start, h.end, windowStart, windowEnd)) {
        out.push({ start: Math.max(h.start, windowStart), end: Math.min(h.end, windowEnd), id: h.id, kind: 'handover' });
      }
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }
}

module.exports = { Calendar, parseTimeOfDay, DAY_MS };

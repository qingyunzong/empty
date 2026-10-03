import { CODES, PlanError } from './errors.js';

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

export function parseInstant(value, field) {
  if (typeof value !== 'string') {
    throw new PlanError(CODES.VALIDATION, `${field} must be an ISO timestamp string`);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new PlanError(CODES.VALIDATION, `${field} is not a valid timestamp: ${value}`);
  }
  return t;
}

function parseTimeOfDay(value, field) {
  const m = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  if (!m) {
    throw new PlanError(CODES.VALIDATION, `${field} must be "HH:MM" (24h), got ${JSON.stringify(value)}`);
  }
  return (Number(m[1]) * 60 + Number(m[2])) * MINUTE_MS;
}

const dayFloor = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function subtractIntervals(base, blocks) {
  const cleanBlocks = blocks.filter(([s, e]) => e > s);
  const out = [];
  for (const [bs, be] of base) {
    let cur = bs;
    for (const [ks, ke] of cleanBlocks) {
      if (ke <= cur) continue;
      if (ks >= be) break;
      if (ks > cur) out.push([cur, Math.min(ks, be)]);
      cur = Math.max(cur, ke);
      if (cur >= be) break;
    }
    if (cur < be) out.push([cur, be]);
  }
  return out.filter(([s, e]) => e > s);
}

function normalizeShift(raw, index) {
  const field = `calendar.shifts[${index}]`;
  if (raw === null || typeof raw !== 'object') {
    throw new PlanError(CODES.VALIDATION, `${field} must be an object`);
  }
  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    throw new PlanError(CODES.VALIDATION, `${field}.days must be a non-empty array of weekdays (0=Sunday..6=Saturday, UTC)`);
  }
  const days = raw.days.map((d) => {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new PlanError(CODES.VALIDATION, `${field}.days entries must be integers in 0..6, got ${d}`);
    }
    return d;
  });
  const startMs = parseTimeOfDay(raw.start, `${field}.start`);
  const endMs = parseTimeOfDay(raw.end, `${field}.end`);
  if (endMs <= startMs) {
    throw new PlanError(CODES.VALIDATION, `${field}: end must be after start (overnight shifts are not supported)`);
  }
  return { days, startMs, endMs };
}

function validateShiftOverlaps(shifts) {
  for (let day = 0; day < 7; day += 1) {
    const spans = shifts
      .filter((s) => s.days.includes(day))
      .map((s) => [s.startMs, s.endMs])
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i][0] < spans[i - 1][1]) {
        throw new PlanError(CODES.CALENDAR_OVERLAP, `overlapping shifts on weekday ${day}`, { weekday: day });
      }
    }
  }
}

function normalizeDowntime(raw) {
  const parsed = raw
    .map((d, i) => {
      const s = parseInstant(d?.start, `calendar.downtime[${i}].start`);
      const e = parseInstant(d?.end, `calendar.downtime[${i}].end`);
      if (e <= s) {
        throw new PlanError(CODES.VALIDATION, `calendar.downtime[${i}]: end must be after start`);
      }
      return [s, e];
    })
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of parsed) {
    const last = out[out.length - 1];
    if (last && s < last[1]) {
      throw new PlanError(CODES.CALENDAR_OVERLAP, 'overlapping downtime intervals', {
        start: new Date(s).toISOString(),
      });
    }
    if (last && s === last[1]) last[1] = e;
    else out.push([s, e]);
  }
  return out;
}

function normalizeRestDay(value) {
  const ok =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!ok) {
    throw new PlanError(CODES.VALIDATION, `calendar.restDays entries must be "YYYY-MM-DD", got ${JSON.stringify(value)}`);
  }
  return value;
}

export class Calendar {
  constructor(spec = {}) {
    if (spec.start === undefined) {
      throw new PlanError(CODES.VALIDATION, 'calendar.start (ISO timestamp) is required');
    }
    this.start = parseInstant(spec.start, 'calendar.start');
    this.horizonDays = spec.horizonDays ?? 60;
    if (!(typeof this.horizonDays === 'number' && this.horizonDays > 0)) {
      throw new PlanError(CODES.VALIDATION, 'calendar.horizonDays must be a positive number');
    }
    this.shifts = (spec.shifts ?? []).map((s, i) => normalizeShift(s, i));
    validateShiftOverlaps(this.shifts);
    this.restDays = new Set((spec.restDays ?? []).map(normalizeRestDay));
    this.downtime = normalizeDowntime(spec.downtime ?? []);
    this.endOfHorizon = this.start + this.horizonDays * DAY_MS;
    this.cache = [];
    this.nextDay = dayFloor(this.start);
    this.exhausted = false;
  }

  dayWorkingIntervals(dayStart) {
    if (this.restDays.has(isoDate(dayStart))) return [];
    const weekday = new Date(dayStart).getUTCDay();
    const shifts = this.shifts
      .filter((s) => s.days.includes(weekday))
      .map((s) => [dayStart + s.startMs, dayStart + s.endMs]);
    if (shifts.length === 0) return [];
    const merged = mergeIntervals(shifts);
    const blocks = this.downtime.filter(([s, e]) => e > dayStart && s < dayStart + DAY_MS);
    const available = subtractIntervals(merged, blocks);
    return available
      .map(([s, e]) => [Math.max(s, this.start), e])
      .filter(([s, e]) => e > s);
  }

  extendOneDay() {
    if (this.exhausted) return;
    if (this.nextDay > this.endOfHorizon) {
      this.exhausted = true;
      return;
    }
    this.cache.push(...this.dayWorkingIntervals(this.nextDay));
    this.nextDay += DAY_MS;
  }

  extendTo(t) {
    while (!this.exhausted && (this.cache.length === 0 || this.cache[this.cache.length - 1][1] < t)) {
      this.extendOneDay();
    }
  }

  *workingIntervalsFrom(t) {
    let i = 0;
    for (;;) {
      while (i >= this.cache.length && !this.exhausted) this.extendOneDay();
      if (i >= this.cache.length) return;
      const [s, e] = this.cache[i];
      i += 1;
      if (e > t) yield [Math.max(s, t), e];
    }
  }

  *freeIntervalsFrom(busy, t) {
    for (const [ws, we] of this.workingIntervalsFrom(t)) {
      for (const sub of subtractIntervals([[ws, we]], busy)) yield sub;
    }
  }

  firstFit(busy, release, durationMs) {
    for (const [fs, fe] of this.freeIntervalsFrom(busy, release)) {
      const s = Math.max(fs, release);
      if (s + durationMs <= fe) return s;
    }
    return null;
  }

  workingTimeBetween(a, b) {
    if (b <= a) return 0;
    this.extendTo(b);
    let sum = 0;
    for (const [s, e] of this.cache) {
      if (e <= a) continue;
      if (s >= b) break;
      sum += Math.min(e, b) - Math.max(s, a);
    }
    return sum;
  }
}

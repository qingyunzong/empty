// Business calendars: cutoff time, weekends, holidays, data horizon.
//
// A settlement day D owns the half-open local interval
//   [ cutoff(prevBusinessDay(D)), cutoff(D) )
// i.e. a transaction belongs to D iff its local time falls in that interval.
// Exactly on a boundary (== cutoff) the half-open rule assigns it to D,
// the *later* of the two adjacent settlement days.
import { errInput } from './errors.js';
import { parseDate, parseHhMm, formatDate, dateOfLocal, timeOfDay, dayOfWeek } from './civil.js';
import { resolveLocal } from './tztable.js';

const MAX_SCAN_DAYS = 370;

export function loadCalendar(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errInput('calendar must be an object');
  }
  for (const key of ['id', 'version', 'zone', 'cutoff']) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) {
      throw errInput(`calendar: "${key}" must be a non-empty string`);
    }
  }
  const weekend = raw.weekend ?? [0, 6];
  if (!Array.isArray(weekend) || weekend.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw errInput('calendar: "weekend" must be an array of weekday numbers 0..6');
  }
  if (!Array.isArray(raw.holidays)) throw errInput('calendar: "holidays" must be an array of YYYY-MM-DD');
  const holidays = new Set(raw.holidays.map((h) => parseDate(h, `calendar ${raw.id} holiday`)));
  if (typeof raw.horizon !== 'string') throw errInput(`calendar ${raw.id}: "horizon" (YYYY-MM-DD) is required`);
  return {
    id: raw.id,
    version: raw.version,
    zone: raw.zone,
    cutoffMin: parseHhMm(raw.cutoff, `calendar ${raw.id} cutoff`),
    weekend: new Set(weekend),
    holidays,
    horizonDay: parseDate(raw.horizon, `calendar ${raw.id} horizon`),
  };
}

export function isBusinessDay(cal, dayNum) {
  return !cal.weekend.has(dayOfWeek(dayNum)) && !cal.holidays.has(dayNum);
}

// First business day strictly after dayNum; null when beyond the data horizon.
export function nextBusinessDay(cal, dayNum) {
  for (let d = dayNum + 1; d <= dayNum + MAX_SCAN_DAYS; d += 1) {
    if (d > cal.horizonDay) return null;
    if (isBusinessDay(cal, d)) return d;
  }
  return null;
}

// Last business day strictly before dayNum (no horizon limit backwards:
// intervals reaching into the past are still well-defined).
export function prevBusinessDay(cal, dayNum) {
  for (let d = dayNum - 1; d >= dayNum - MAX_SCAN_DAYS; d -= 1) {
    if (isBusinessDay(cal, d)) return d;
  }
  throw errInput(`calendar ${cal.id}: no business day found before ${formatDate(dayNum)}`);
}

// Settlement date by the direct local rule (used by the reference algorithm
// and as the horizon check). Returns null when the date is beyond the horizon.
export function settlementDateFor(cal, localMin) {
  const day = dateOfLocal(localMin);
  const tod = timeOfDay(localMin);
  if (tod >= cal.cutoffMin) return nextBusinessDay(cal, day);
  if (isBusinessDay(cal, day)) return day <= cal.horizonDay ? day : null;
  return nextBusinessDay(cal, day);
}

// UTC interval [start, end) owned by settlement day `dateDay`.
export function settlementInterval(tzTable, cal, dateDay) {
  const prev = prevBusinessDay(cal, dateDay);
  const startLocal = prev * 1440 + cal.cutoffMin;
  const endLocal = dateDay * 1440 + cal.cutoffMin;
  const start = resolveLocal(tzTable, cal.zone, startLocal);
  const end = resolveLocal(tzTable, cal.zone, endLocal);
  return {
    date: formatDate(dateDay),
    startUtcMin: start.utcMin,
    endUtcMin: end.utcMin,
  };
}

// Merge contiguous half-open intervals; returns verifiable merge proof.
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startUtcMin - b.startUtcMin);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.startUtcMin === last.endUtcMin) {
      last.endUtcMin = iv.endUtcMin;
      last.toDate = iv.date;
      last.dayCount += 1;
    } else {
      merged.push({ startUtcMin: iv.startUtcMin, endUtcMin: iv.endUtcMin, fromDate: iv.date, toDate: iv.date, dayCount: 1 });
    }
  }
  return merged;
}

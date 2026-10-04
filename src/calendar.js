import { addDays, dayOfWeek } from './schedule.js';

// Versioned business-day calendar. Weekdays: 0=Sunday .. 6=Saturday.
export function makeCalendar({ holidays = [], weekends = [0, 6] } = {}) {
  return { holidays: new Set(holidays), weekends: new Set(weekends) };
}

export function isBusinessDay(cal, dateStr) {
  if (cal.holidays.has(dateStr)) return false;
  return !cal.weekends.has(dayOfWeek(dateStr));
}

// Roll forward to the next business day. Deterministic, fixed timezone.
export function adjust(cal, dateStr) {
  let d = dateStr;
  while (!isBusinessDay(cal, d)) d = addDays(d, 1);
  return d;
}

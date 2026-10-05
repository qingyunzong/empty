import { dayNumberToDate } from './time.js';

// Merge a set of settlement day numbers into maximal contiguous intervals.
// Returns [{ fromDay, toDay, days }] with ISO dates, sorted by fromDay.
export function mergeDayIntervals(dayNumbers) {
  const sorted = [...new Set(dayNumbers)].sort((a, b) => a - b);
  const out = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && d === last.toDayNum + 1) {
      last.toDayNum = d;
    } else {
      out.push({ fromDayNum: d, toDayNum: d });
    }
  }
  return out.map((r) => ({
    fromDay: dayNumberToDate(r.fromDayNum),
    toDay: dayNumberToDate(r.toDayNum),
    days: r.toDayNum - r.fromDayNum + 1,
  }));
}

import { ClearingError, E } from './errors.js';
import { dateToDayNumber, parseHHMM } from './time.js';

// Versioned business calendars.
// Format:
// {
//   "version": "cal-2024.1",
//   "calendars": {
//     "NY": { "zone": "America/New_York", "cutoff": "17:00",
//             "weekend": [0, 6], "holidays": ["2024-01-01"] }
//   }
// }
// weekday numbers: 0 = Sunday. Day-cut interval for settlement day D is the
// half-open interval [cutoff(prevBusinessDay(D)), cutoff(D)) in local time.
export class CalendarSet {
  constructor(raw, tz) {
    if (!raw || typeof raw !== 'object' || typeof raw.version !== 'string' || !raw.calendars) {
      throw new Error('invalid calendar file: expected {version, calendars}');
    }
    this.version = raw.version;
    this.raw = raw;
    this.tz = tz;
    this.calendars = new Map();
    this.#cutoffCache = new Map();
    for (const [id, c] of Object.entries(raw.calendars)) {
      if (!tz.hasZone(c.zone)) {
        throw new ClearingError(E.TZ_UNKNOWN, `calendar ${id}: unknown zone ${c.zone}`, { zone: c.zone });
      }
      this.calendars.set(id, {
        id,
        zone: c.zone,
        cutoff: parseHHMM(c.cutoff ?? '17:00'),
        weekend: new Set(c.weekend ?? [0, 6]),
        holidays: new Set((c.holidays ?? []).map(dateToDayNumber)),
      });
    }
  }

  #cutoffCache;

  get(id) {
    const c = this.calendars.get(id);
    if (!c) throw new ClearingError(E.TZ_UNKNOWN, `unknown calendar: ${id}`, { calendar: id });
    return c;
  }

  isBusinessDay(cal, dayNum) {
    const dow = (((dayNum % 7) + 7) % 7 + 4) % 7; // 1970-01-01 was Thursday (4)
    return !cal.weekend.has(dow) && !cal.holidays.has(dayNum);
  }

  nextBusinessDay(cal, dayNum) {
    let d = dayNum + 1;
    while (!this.isBusinessDay(cal, d)) d += 1;
    return d;
  }

  prevBusinessDay(cal, dayNum) {
    let d = dayNum - 1;
    while (!this.isBusinessDay(cal, d)) d -= 1;
    return d;
  }

  firstBusinessDayOnOrAfter(cal, dayNum) {
    let d = dayNum;
    while (!this.isBusinessDay(cal, d)) d += 1;
    return d;
  }

  // UTC instant of the cutoff on local business day `dayNum`.
  // A cutoff landing in a DST gap/overlap is a calendar configuration error
  // and surfaces as E_GAP / E_OVERLAP.
  cutoffUtc(cal, dayNum) {
    const key = `${cal.id}|${dayNum}`;
    let v = this.#cutoffCache.get(key);
    if (v === undefined) {
      v = this.tz.localToUtc(cal.zone, dayNum * 1440 + cal.cutoff);
      this.#cutoffCache.set(key, v);
    }
    return v;
  }
}

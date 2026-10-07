'use strict';

const { CalendarError } = require('./intervals');

const MINUTE_MS = 60000;

// Explicit timezone conversion table. Each zone is a list of eras:
//   { from: <utc ms when this era starts>, offsetMinutes: <minutes ahead of UTC> }
// Eras are sorted by `from`; the last era extends to +Infinity.
class TimezoneTable {
  constructor(defs) {
    if (!defs || typeof defs !== 'object') {
      throw new CalendarError('INVALID_TIMEZONE_TABLE', 'timezone table must be an object');
    }
    this.zones = new Map();
    for (const [name, eras] of Object.entries(defs)) {
      if (!Array.isArray(eras) || eras.length === 0) {
        throw new CalendarError('INVALID_TIMEZONE_TABLE', `zone ${name} needs at least one era`);
      }
      const sorted = eras.map((e) => {
        if (!Number.isSafeInteger(e.from) || !Number.isSafeInteger(e.offsetMinutes)) {
          throw new CalendarError('INVALID_TIMEZONE_TABLE', `zone ${name} has a malformed era`);
        }
        return { from: e.from, offsetMinutes: e.offsetMinutes };
      });
      sorted.sort((a, b) => a.from - b.from);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].from === sorted[i - 1].from) {
          throw new CalendarError('INVALID_TIMEZONE_TABLE', `zone ${name} has duplicate era starts`);
        }
      }
      this.zones.set(name, sorted);
    }
  }

  eras(name) {
    const z = this.zones.get(name);
    if (!z) throw new CalendarError('UNKNOWN_TIMEZONE', `unknown timezone: ${name}`);
    return z;
  }

  eraForUtc(name, utcMs) {
    const z = this.eras(name);
    let lo = 0;
    let hi = z.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (z[mid].from <= utcMs) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return z[ans];
  }

  offsetMinutesAt(name, utcMs) {
    return this.eraForUtc(name, utcMs).offsetMinutes;
  }

  utcToLocal(name, utcMs) {
    return utcMs + this.offsetMinutesAt(name, utcMs) * MINUTE_MS;
  }

  // Local wall-clock ms -> utc ms. Era i covers utc [from_i, from_{i+1}), so
  // its local span is [from_i + off_i, from_{i+1} + off_i). A local time
  // falling in a gap (forward offset switch) is an error; in an overlap
  // (backward switch) the earliest matching era wins.
  localToUtc(name, localMs) {
    const z = this.eras(name);
    for (let i = 0; i < z.length; i++) {
      const spanStart = z[i].from + z[i].offsetMinutes * MINUTE_MS;
      const spanEnd = i + 1 < z.length
        ? z[i + 1].from + z[i].offsetMinutes * MINUTE_MS
        : Infinity;
      if (localMs >= spanStart && localMs < spanEnd) {
        return localMs - z[i].offsetMinutes * MINUTE_MS;
      }
    }
    throw new CalendarError('INVALID_LOCAL_TIME', `local time ${localMs} does not exist in ${name}`, { zone: name, localMs });
  }
}

module.exports = { TimezoneTable, MINUTE_MS };

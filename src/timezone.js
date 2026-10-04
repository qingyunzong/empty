import { QError } from './errors.js';

// Offline timezone conversion table. Each zone is a list of offset segments:
// { from: ISO instant | null, offsetMinutes: integer }. The segment with the
// greatest `from` not after the queried instant wins; instants before the
// first segment use the first segment's offset.
export class TimezoneTable {
  constructor(zones = {}) {
    this.zones = new Map();
    for (const [name, segments] of Object.entries(zones)) {
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new QError('ILLEGAL_PERIOD', `timezone "${name}" needs at least one offset segment`);
      }
      const parsed = segments.map((seg) => {
        const from = seg.from == null ? Number.NEGATIVE_INFINITY : Date.parse(seg.from);
        if (Number.isNaN(from)) {
          throw new QError('ILLEGAL_PERIOD', `timezone "${name}" has an unparseable segment start`);
        }
        if (!Number.isInteger(seg.offsetMinutes) || seg.offsetMinutes < -840 || seg.offsetMinutes > 840) {
          throw new QError('ILLEGAL_PERIOD', `timezone "${name}" has an invalid offsetMinutes`);
        }
        return { from, offsetMinutes: seg.offsetMinutes };
      });
      parsed.sort((a, b) => a.from - b.from);
      this.zones.set(name, parsed);
    }
  }

  has(name) {
    return this.zones.has(name);
  }

  offsetMinutesAt(name, utcMs) {
    const segments = this.zones.get(name);
    if (!segments) {
      throw new QError('UNKNOWN_TIMEZONE', `unknown timezone "${name}"`);
    }
    let chosen = segments[0];
    for (const seg of segments) {
      if (seg.from <= utcMs) chosen = seg;
      else break;
    }
    return chosen.offsetMinutes;
  }

  // Shift a UTC instant into zone-local wall-clock milliseconds (to be read
  // back with Date UTC getters).
  toLocalMs(name, utcMs) {
    return utcMs + this.offsetMinutesAt(name, utcMs) * 60000;
  }
}

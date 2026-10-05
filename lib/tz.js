import { ClearingError, E } from './errors.js';
import { parseUtcMinutes, formatUtcMinutes, formatLocalMinutes } from './time.js';

// Versioned, input-supplied timezone table.
// Format:
// {
//   "version": "tz-2024a-mini",
//   "zones": {
//     "America/New_York": [
//       { "from": "1970-01-01T00:00Z", "offset": -300 },
//       { "from": "2024-03-10T07:00Z", "offset": -240 }
//     ]
//   }
// }
// Each period [from, next.from) carries a fixed offset (minutes east of UTC).
export class TzTable {
  constructor(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.version !== 'string' || !raw.zones) {
      throw new Error('invalid tz table: expected {version, zones}');
    }
    this.version = raw.version;
    this.raw = raw;
    this.zones = new Map();
    for (const [name, periods] of Object.entries(raw.zones)) {
      if (!Array.isArray(periods) || periods.length === 0) {
        throw new Error(`tz zone ${name}: expected non-empty period array`);
      }
      const parsed = periods.map((p) => {
        if (!Number.isInteger(p.offset) || p.offset < -840 || p.offset > 840) {
          throw new Error(`tz zone ${name}: bad offset ${p.offset}`);
        }
        return { from: parseUtcMinutes(p.from), offset: p.offset };
      });
      for (let i = 1; i < parsed.length; i += 1) {
        if (parsed[i].from <= parsed[i - 1].from) {
          throw new Error(`tz zone ${name}: periods must be strictly increasing`);
        }
      }
      this.zones.set(name, parsed);
    }
  }

  hasZone(zone) {
    return this.zones.has(zone);
  }

  #periods(zone) {
    const ps = this.zones.get(zone);
    if (!ps) throw new ClearingError(E.TZ_UNKNOWN, `unknown time zone: ${zone}`, { zone });
    return ps;
  }

  offsetAt(zone, utcMin) {
    const ps = this.#periods(zone);
    if (utcMin < ps[0].from) {
      throw new ClearingError(E.TZ_UNKNOWN, `tz table ${this.version} has no period covering ${formatUtcMinutes(utcMin)} in ${zone}`, { zone });
    }
    let lo = 0;
    let hi = ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ps[mid].from <= utcMin) lo = mid;
      else hi = mid - 1;
    }
    return ps[lo].offset;
  }

  utcToLocal(zone, utcMin) {
    return utcMin + this.offsetAt(zone, utcMin);
  }

  // All utc instants whose local reading equals localMin. 0 => gap, >1 => overlap.
  localToUtcCandidates(zone, localMin) {
    const ps = this.#periods(zone);
    const out = [];
    for (let i = 0; i < ps.length; i += 1) {
      const utc = localMin - ps[i].offset;
      const end = i + 1 < ps.length ? ps[i + 1].from : Infinity;
      if (utc >= ps[i].from && utc < end && !out.includes(utc)) out.push(utc);
    }
    return out;
  }

  // Strict local -> utc. Illegal (gap) or ambiguous (overlap) local times are
  // rejected, never silently shifted.
  localToUtc(zone, localMin) {
    const c = this.localToUtcCandidates(zone, localMin);
    const local = formatLocalMinutes(localMin);
    if (c.length === 0) {
      throw new ClearingError(E.GAP, `local time does not exist in ${zone}: ${local}`, { zone, local });
    }
    if (c.length > 1) {
      throw new ClearingError(E.OVERLAP, `local time is ambiguous in ${zone}: ${local}`, {
        zone,
        local,
        candidates: c.map(formatUtcMinutes),
      });
    }
    return c[0];
  }
}

'use strict';

class MergeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
  }
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

// Parse a naive local timestamp "YYYY-MM-DDTHH:mm:ss[.sss]" into wall-clock
// milliseconds (the instant the wall clock would read if it were UTC).
// Never touches the system timezone.
function parseLocalToWallMs(local) {
  if (typeof local !== 'string') {
    throw new MergeError('INVALID_LOCAL_TIME', `local time must be a string, got: ${String(local)}`);
  }
  const m = LOCAL_RE.exec(local.trim());
  if (!m) {
    throw new MergeError('INVALID_LOCAL_TIME', `invalid local time (want YYYY-MM-DDTHH:mm:ss[.sss]): ${local}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new MergeError('INVALID_LOCAL_TIME', `local time component out of range: ${local}`);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

// Parse a UTC instant given either as epoch milliseconds (number) or as an
// ISO-8601 string. Naive strings are interpreted as UTC explicitly so the
// result never depends on the system timezone.
function parseUtcInstant(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const v = value.trim();
    let t;
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
      t = Date.parse(v);
    } else if (v.includes('T')) {
      t = Date.parse(`${v}Z`);
    } else {
      t = Date.parse(`${v}T00:00:00Z`);
    }
    if (Number.isNaN(t)) {
      throw new MergeError('INVALID_TIME', `invalid UTC instant for ${field}: ${value}`);
    }
    return t;
  }
  throw new MergeError('INVALID_TIME', `invalid UTC instant for ${field}: ${value}`);
}

class ZoneTable {
  constructor() {
    this.zones = new Map();
  }

  // offsets: [{ effectiveFromUtc, offsetMinutes }] with strictly increasing
  // effective instants. Anything else is an OFFSET_TABLE_CONFLICT.
  define(zoneId, offsets) {
    if (typeof zoneId !== 'string' || zoneId.length === 0) {
      throw new MergeError('OFFSET_TABLE_CONFLICT', 'zone id must be a non-empty string');
    }
    if (!Array.isArray(offsets) || offsets.length === 0) {
      throw new MergeError('OFFSET_TABLE_CONFLICT', `zone ${zoneId}: offsets must be a non-empty array`);
    }
    const segments = offsets.map((o, i) => {
      if (o === null || typeof o !== 'object') {
        throw new MergeError('OFFSET_TABLE_CONFLICT', `zone ${zoneId}: offsets[${i}] must be an object`);
      }
      const raw = o.effectiveFromUtc !== undefined ? o.effectiveFromUtc : o.effectiveFromUtcMs;
      const from = parseUtcInstant(raw, `zone ${zoneId} offsets[${i}].effectiveFromUtc`);
      const offsetMinutes = o.offsetMinutes;
      if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) >= 24 * 60) {
        throw new MergeError(
          'OFFSET_TABLE_CONFLICT',
          `zone ${zoneId}: offsets[${i}].offsetMinutes must be an integer in (-1440, 1440), got ${offsetMinutes}`
        );
      }
      return { from, offsetMinutes };
    });
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].from <= segments[i - 1].from) {
        throw new MergeError(
          'OFFSET_TABLE_CONFLICT',
          `zone ${zoneId}: effectiveFromUtc must be strictly increasing (offsets[${i}] conflicts with offsets[${i - 1}])`
        );
      }
    }
    this.zones.set(zoneId, segments);
    return { zone: zoneId, segments: segments.length };
  }

  has(zoneId) {
    return this.zones.has(zoneId);
  }

  // Convert a naive local timestamp in the given zone to UTC epoch ms.
  // Each segment applies to UTC instants in [from, nextFrom). A local time is
  // matched against every segment; if several segments match (clock turned
  // back) the newest segment wins deterministically. If none matches (clock
  // skipped forward) the local time does not exist -> LOCAL_TIME_INVALID.
  toUtc(zoneId, local) {
    const segments = this.zones.get(zoneId);
    if (!segments) {
      throw new MergeError('UNKNOWN_ZONE', `unknown zone: ${zoneId}`);
    }
    const wall = parseLocalToWallMs(local);
    let best = null;
    for (let i = 0; i < segments.length; i++) {
      const utc = wall - segments[i].offsetMinutes * 60000;
      const hi = i + 1 < segments.length ? segments[i + 1].from : Infinity;
      if (utc >= segments[i].from && utc < hi) {
        if (!best || segments[i].from > best.from) {
          best = { from: segments[i].from, utc };
        }
      }
    }
    if (!best) {
      throw new MergeError('LOCAL_TIME_INVALID', `local time ${local} does not exist in zone ${zoneId} (offset switch gap)`);
    }
    return best.utc;
  }
}

module.exports = { MergeError, ZoneTable, parseLocalToWallMs, parseUtcInstant };

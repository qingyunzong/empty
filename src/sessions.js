const GAP_MS = 10 * 60 * 1000;

export { GAP_MS };

export const ErrorCodes = Object.freeze({
  LATE: 'LATE',
  STALE_VERSION: 'STALE_VERSION',
  UNKNOWN_RETRACT: 'UNKNOWN_RETRACT',
});

export class ValidationError extends Error {}

export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function isValidId(id) {
  return (typeof id === 'string' && id.length > 0) ||
    (typeof id === 'number' && Number.isFinite(id));
}

function isValidVersion(version) {
  return typeof version === 'number' && Number.isInteger(version) && version >= 0;
}

// Validates a raw parsed JSON line and returns a normalized record with
// timestamps converted to epoch milliseconds. Throws ValidationError.
export function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('record must be a JSON object');
  }
  switch (raw.op) {
    case 'UPSERT': {
      if (!isValidId(raw.id)) throw new ValidationError('UPSERT requires a non-empty "id"');
      if (typeof raw.station !== 'string' || raw.station.length === 0) {
        throw new ValidationError('UPSERT requires a non-empty "station"');
      }
      const eventTime = parseTime(raw.eventTime);
      if (eventTime === null) throw new ValidationError('UPSERT has invalid "eventTime"');
      if (typeof raw.temp !== 'number' || !Number.isFinite(raw.temp)) {
        throw new ValidationError('UPSERT requires a numeric "temp"');
      }
      if (!isValidVersion(raw.version)) {
        throw new ValidationError('UPSERT requires a non-negative integer "version"');
      }
      return { op: 'UPSERT', id: raw.id, station: raw.station, eventTime, temp: raw.temp, version: raw.version };
    }
    case 'RETRACT': {
      if (!isValidId(raw.id)) throw new ValidationError('RETRACT requires a non-empty "id"');
      if (!isValidVersion(raw.version)) {
        throw new ValidationError('RETRACT requires a non-negative integer "version"');
      }
      return { op: 'RETRACT', id: raw.id, version: raw.version };
    }
    case 'WATERMARK': {
      const ts = parseTime(raw.ts);
      if (ts === null) throw new ValidationError('WATERMARK has invalid "ts"');
      return { op: 'WATERMARK', ts };
    }
    default:
      throw new ValidationError(`unknown or missing "op": ${JSON.stringify(raw.op)}`);
  }
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function buildSessionOutput(station, members) {
  let sum = 0;
  let maxVersion = 0;
  const ids = [];
  for (const member of members) {
    sum += member.temp;
    if (member.version > maxVersion) maxVersion = member.version;
    ids.push(member.id);
  }
  return {
    station,
    start: new Date(members[0].eventTime).toISOString(),
    end: new Date(members[members.length - 1].eventTime).toISOString(),
    count: members.length,
    avgTemp: round6(sum / members.length),
    ids,
    version: maxVersion,
  };
}

// Groups a station's live observations (sorted by eventTime) into sessions:
// adjacent observations more than GAP_MS apart are split into different
// sessions, otherwise they merge into one.
function groupIntoSessions(points) {
  const sessions = [];
  let current = null;
  for (const point of points) {
    if (current !== null && point.eventTime - current[current.length - 1].eventTime > GAP_MS) {
      sessions.push(current);
      current = null;
    }
    if (current === null) current = [];
    current.push(point);
  }
  if (current !== null) sessions.push(current);
  return sessions;
}

export class SessionProcessor {
  // id -> { id, station, eventTime, temp, version, state }
  // state: 'live' | 'retracted' | 'finalized'
  #observations = new Map();
  #watermark = null; // epoch ms, monotonically increasing

  // Returns { emitted: SessionOutput[], error: null | { code, message } }.
  // On error the processor state is left untouched.
  process(record) {
    switch (record.op) {
      case 'UPSERT': return this.#upsert(record);
      case 'RETRACT': return this.#retract(record);
      case 'WATERMARK': return this.#applyWatermark(record);
      default:
        throw new ValidationError(`record not normalized: ${JSON.stringify(record.op)}`);
    }
  }

  #isLate(eventTime) {
    return this.#watermark !== null && eventTime <= this.#watermark;
  }

  #upsert(record) {
    const existing = this.#observations.get(record.id);
    if (existing !== undefined) {
      if (record.version < existing.version) {
        return this.#error(ErrorCodes.STALE_VERSION,
          `id ${JSON.stringify(record.id)}: version ${record.version} < known version ${existing.version}`);
      }
      if (record.version === existing.version) {
        return { emitted: [], error: null }; // idempotent replay
      }
    }
    if (this.#isLate(record.eventTime)) {
      return this.#error(ErrorCodes.LATE,
        `id ${JSON.stringify(record.id)}: eventTime ${new Date(record.eventTime).toISOString()} is at or before the watermark`);
    }
    this.#observations.set(record.id, {
      id: record.id,
      station: record.station,
      eventTime: record.eventTime,
      temp: record.temp,
      version: record.version,
      state: 'live',
    });
    return { emitted: [], error: null };
  }

  #retract(record) {
    const existing = this.#observations.get(record.id);
    if (existing === undefined) {
      return this.#error(ErrorCodes.UNKNOWN_RETRACT,
        `id ${JSON.stringify(record.id)}: no such observation`);
    }
    if (record.version < existing.version) {
      return this.#error(ErrorCodes.STALE_VERSION,
        `id ${JSON.stringify(record.id)}: version ${record.version} < known version ${existing.version}`);
    }
    if (existing.state === 'retracted' && record.version === existing.version) {
      return { emitted: [], error: null }; // idempotent replay
    }
    if (existing.state === 'finalized' ||
        (existing.state === 'live' && this.#isLate(existing.eventTime))) {
      return this.#error(ErrorCodes.LATE,
        `id ${JSON.stringify(record.id)}: observation is at or before the watermark`);
    }
    existing.state = 'retracted';
    existing.version = record.version;
    return { emitted: [], error: null };
  }

  #applyWatermark(record) {
    if (this.#watermark === null || record.ts > this.#watermark) {
      this.#watermark = record.ts;
    }
    const byStation = new Map();
    for (const observation of this.#observations.values()) {
      if (observation.state !== 'live') continue;
      let bucket = byStation.get(observation.station);
      if (bucket === undefined) {
        bucket = [];
        byStation.set(observation.station, bucket);
      }
      bucket.push(observation);
    }
    const emitted = [];
    for (const [station, points] of byStation) {
      points.sort((a, b) => a.eventTime - b.eventTime || String(a.id).localeCompare(String(b.id)));
      for (const session of groupIntoSessions(points)) {
        const maxEventTime = session[session.length - 1].eventTime;
        if (this.#watermark > maxEventTime + GAP_MS) {
          for (const member of session) member.state = 'finalized';
          emitted.push(buildSessionOutput(station, session));
        }
      }
    }
    emitted.sort((a, b) => a.start.localeCompare(b.start) || a.station.localeCompare(b.station));
    return { emitted, error: null };
  }

  #error(code, message) {
    return { emitted: [], error: { code, message } };
  }
}

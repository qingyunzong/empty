'use strict';

const { CODES, ReconError } = require('./errors');

const POLICIES = Object.freeze(['strict', 'earlier', 'later']);

function isLeapLike(value) {
  return typeof value === 'string' && /T\d{2}:\d{2}:60/.test(value);
}

function parseUtcInstant(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    if (isLeapLike(value)) {
      throw new ReconError(
        CODES.TZVER,
        `leap-style instant "${value}" has no numeric epoch; it must be resolved via the table's explicit map`,
        { instant: value }
      );
    }
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  throw new ReconError(CODES.TZVER, `invalid UTC instant: ${String(value)}`, { instant: value });
}

function parseCivil(local) {
  if (typeof local !== 'string') {
    throw new ReconError(CODES.TZVER, `invalid local civil time: ${String(local)}`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) {
    throw new ReconError(CODES.TZVER, `invalid local civil time: ${local}`, { local });
  }
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return Math.floor(ms / 1000);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatOffset(offsetSeconds) {
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const abs = Math.abs(offsetSeconds);
  return `${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

function formatLocal(epochSeconds, offsetSeconds) {
  const d = new Date((epochSeconds + offsetSeconds) * 1000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date}T${time}${formatOffset(offsetSeconds)}`;
}

function normalizeTable(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ReconError(CODES.TZVER, 'timezone table must be an object');
  }
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw new ReconError(CODES.TZVER, 'timezone table requires a non-empty string "version"');
  }
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw new ReconError(CODES.TZVER, `table ${raw.version}: "segments" must be a non-empty array`);
  }
  const segments = raw.segments.map((s, i) => {
    if (typeof s.offsetSeconds !== 'number' || !Number.isInteger(s.offsetSeconds)) {
      throw new ReconError(CODES.TZVER, `table ${raw.version} segment[${i}]: offsetSeconds must be an integer`);
    }
    const utcStart = parseUtcInstant(s.utcStart);
    const utcEnd = parseUtcInstant(s.utcEnd);
    if (!(utcStart < utcEnd)) {
      throw new ReconError(CODES.TZVER, `table ${raw.version} segment[${i}]: utcStart must be < utcEnd`);
    }
    return { utcStart, utcEnd, offsetSeconds: s.offsetSeconds };
  });
  segments.sort((a, b) => a.utcStart - b.utcStart);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].utcStart < segments[i - 1].utcEnd) {
      throw new ReconError(CODES.TZVER, `table ${raw.version}: segments overlap at index ${i}`);
    }
  }
  const explicit = {};
  if (raw.explicit !== undefined) {
    if (typeof raw.explicit !== 'object' || raw.explicit === null || Array.isArray(raw.explicit)) {
      throw new ReconError(CODES.TZVER, `table ${raw.version}: "explicit" must be an object map`);
    }
    for (const [k, v] of Object.entries(raw.explicit)) {
      if (!isLeapLike(k) || typeof v !== 'string') {
        throw new ReconError(
          CODES.TZVER,
          `table ${raw.version}: explicit keys must be leap-style UTC instants mapping to local strings`,
          { key: k }
        );
      }
      explicit[k] = v;
    }
  }
  return Object.freeze({
    version: raw.version,
    segments: Object.freeze(segments),
    explicit: Object.freeze(explicit),
  });
}

class TzRegistry {
  constructor() {
    this.tables = new Map();
    this.currentVersion = null;
  }

  // Hot update: loads a new table version. Versions are immutable: reloading the
  // same version with different content is rejected so history can never be
  // silently rewritten by a table swap.
  load(rawTable) {
    const table = normalizeTable(rawTable);
    const existing = this.tables.get(table.version);
    if (existing) {
      const same =
        JSON.stringify(existing.segments) === JSON.stringify(table.segments) &&
        JSON.stringify(existing.explicit) === JSON.stringify(table.explicit);
      if (!same) {
        throw new ReconError(
          CODES.TZVER,
          `table version "${table.version}" already loaded with different content; versions are immutable, publish a new version`,
          { version: table.version }
        );
      }
      return existing;
    }
    this.tables.set(table.version, table);
    this.currentVersion = table.version;
    return table;
  }

  get(version) {
    const table = this.tables.get(version);
    if (!table) {
      throw new ReconError(CODES.TZVER, `unknown timezone table version: ${String(version)}`, { version });
    }
    return table;
  }

  versions() {
    return [...this.tables.keys()];
  }
}

function findSegment(table, epochSeconds) {
  let lo = 0;
  let hi = table.segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = table.segments[mid];
    if (epochSeconds < seg.utcStart) hi = mid - 1;
    else if (epochSeconds >= seg.utcEnd) lo = mid + 1;
    else return seg;
  }
  return null;
}

// UTC instant -> local time. Leap-style instants (":60") resolve only through
// the table's explicit map; a missing mapping is an E_TZVER table defect.
function utcToLocal(utc, table) {
  if (isLeapLike(utc)) {
    const mapped = table.explicit[utc];
    if (mapped === undefined) {
      throw new ReconError(
        CODES.TZVER,
        `table ${table.version} has no explicit mapping for leap-style instant ${utc}`,
        { version: table.version, instant: utc }
      );
    }
    return { local: mapped, localDay: mapped.slice(0, 10), via: 'explicit', utcEpoch: null };
  }
  const epoch = parseUtcInstant(utc);
  const seg = findSegment(table, epoch);
  if (!seg) {
    throw new ReconError(
      CODES.TZVER,
      `table ${table.version} has no segment covering UTC instant ${typeof utc === 'string' ? utc : epoch}`,
      { version: table.version, instant: utc }
    );
  }
  const local = formatLocal(epoch, seg.offsetSeconds);
  return { local, localDay: local.slice(0, 10), via: 'segment', utcEpoch: epoch };
}

// All UTC epochs whose local civil time equals `local` under this table.
function localCandidates(local, table) {
  if (/:60/.test(local)) {
    const out = [];
    for (const [utc, mapped] of Object.entries(table.explicit)) {
      if (mapped.slice(0, 19) === local.slice(0, 19)) out.push(utc);
    }
    return out;
  }
  const civil = parseCivil(local);
  const out = [];
  for (const seg of table.segments) {
    const utc = civil - seg.offsetSeconds;
    if (utc >= seg.utcStart && utc < seg.utcEnd) out.push(utc);
  }
  return out.sort((a, b) => a - b);
}

function findGap(table, civil) {
  for (let i = 1; i < table.segments.length; i++) {
    const prev = table.segments[i - 1];
    const next = table.segments[i];
    if (prev.utcEnd !== next.utcStart) continue;
    if (next.offsetSeconds <= prev.offsetSeconds) continue; // fold, not gap
    const gapStartLocal = prev.utcEnd + prev.offsetSeconds;
    const gapEndLocal = next.utcStart + next.offsetSeconds;
    if (civil >= gapStartLocal && civil < gapEndLocal) {
      return { boundaryUtc: prev.utcEnd, prev, next };
    }
  }
  return null;
}

function assertPolicy(policy) {
  if (!POLICIES.includes(policy)) {
    throw new ReconError(
      CODES.POLICY,
      `unknown policy "${String(policy)}"; expected one of: ${POLICIES.join(', ')}`,
      { policy }
    );
  }
}

// Local civil time -> UTC instant under a disambiguation policy.
// The resolution is always returned so callers can record it in attestation.
function localToUtc(local, table, policy) {
  assertPolicy(policy);
  const candidates = localCandidates(local, table);
  if (candidates.length === 1) {
    const utc = candidates[0];
    return { utc, utcEpoch: typeof utc === 'number' ? utc : null, resolution: 'unique', candidates };
  }
  if (candidates.length > 1) {
    if (policy === 'strict') {
      throw new ReconError(CODES.AMBIG, `local time ${local} is ambiguous under table ${table.version} (${candidates.length} UTC candidates)`, {
        kind: 'ambiguous', local, version: table.version, candidates,
      });
    }
    const utc = policy === 'earlier' ? candidates[0] : candidates[candidates.length - 1];
    return { utc, utcEpoch: typeof utc === 'number' ? utc : null, resolution: `ambiguous-${policy}`, candidates };
  }
  const civil = parseCivil(local);
  const gap = findGap(table, civil);
  if (!gap) {
    throw new ReconError(CODES.TZVER, `table ${table.version} does not cover local time ${local}`, {
      local, version: table.version,
    });
  }
  if (policy === 'strict') {
    throw new ReconError(CODES.AMBIG, `local time ${local} does not exist under table ${table.version} (gap at UTC boundary ${gap.boundaryUtc})`, {
      kind: 'nonexistent', local, version: table.version, boundaryUtc: gap.boundaryUtc,
    });
  }
  const utc = policy === 'earlier' ? gap.boundaryUtc - 1 : gap.boundaryUtc;
  return { utc, utcEpoch: utc, resolution: `nonexistent-${policy}`, candidates: [] };
}

module.exports = {
  POLICIES,
  TzRegistry,
  normalizeTable,
  isLeapLike,
  parseUtcInstant,
  parseCivil,
  formatLocal,
  utcToLocal,
  localToUtc,
  localCandidates,
};

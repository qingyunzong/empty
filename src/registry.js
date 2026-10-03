'use strict';

const { ReconError, CODES } = require('./errors');
const { parseUtcIso } = require('./time');

const PURPOSES = Object.freeze(['txn', 'settlement', 'fee']);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// Validate and normalize a raw timezone table JSON into an immutable table.
// Raw shape:
// {
//   "version": "v1",
//   "zones": {
//     "Merchant/Zone": {
//       "transitions": [{"utc": "2024-01-01T00:00:00Z", "offsetMinutes": 480}, ...],
//       "leapMap": {"2016-12-31T23:59:60Z": "2017-01-01T00:00:00Z"}
//     }
//   }
// }
function normalizeTable(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ReconError(CODES.E_TZVER, 'table must be an object');
  }
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw new ReconError(CODES.E_TZVER, 'table requires a non-empty string "version"');
  }
  if (!raw.zones || typeof raw.zones !== 'object' || Array.isArray(raw.zones)) {
    throw new ReconError(CODES.E_TZVER, `table ${raw.version} requires "zones"`);
  }
  const zones = new Map();
  for (const [zoneName, zoneRaw] of Object.entries(raw.zones)) {
    if (!Array.isArray(zoneRaw.transitions) || zoneRaw.transitions.length === 0) {
      throw new ReconError(CODES.E_TZVER,
        `zone ${zoneName} in ${raw.version} needs at least one transition`);
    }
    const transitions = zoneRaw.transitions.map((t) => {
      if (typeof t.offsetMinutes !== 'number' || !Number.isInteger(t.offsetMinutes)) {
        throw new ReconError(CODES.E_TZVER,
          `zone ${zoneName}: offsetMinutes must be an integer`);
      }
      return { utcMs: parseUtcIso(t.utc, null), offsetMinutes: t.offsetMinutes };
    });
    transitions.sort((a, b) => a.utcMs - b.utcMs);
    for (let i = 1; i < transitions.length; i++) {
      if (transitions[i].utcMs === transitions[i - 1].utcMs) {
        throw new ReconError(CODES.E_TZVER,
          `zone ${zoneName}: duplicate transition instant`);
      }
    }
    const leapMap = new Map();
    if (zoneRaw.leapMap) {
      for (const [from, to] of Object.entries(zoneRaw.leapMap)) {
        leapMap.set(from, parseUtcIso(to, null));
      }
    }
    zones.set(zoneName, Object.freeze({ transitions, leapMap }));
  }
  return Object.freeze({
    version: raw.version,
    zones,
    fingerprint: stableStringify(raw),
  });
}

// Versioned, append-only registry. Hot update == registering a NEW version.
// A version, once registered, is immutable: re-registering identical content is
// an idempotent no-op; re-registering different content under the same version
// is E_TZVER.
class TzRegistry {
  constructor() {
    this.tables = new Map();
    for (const p of PURPOSES) this.tables.set(p, new Map());
  }

  register(purpose, rawTable) {
    if (!this.tables.has(purpose)) {
      throw new ReconError(CODES.E_TZVER, `unknown table purpose: ${purpose}`);
    }
    const table = normalizeTable(rawTable);
    const byVersion = this.tables.get(purpose);
    const existing = byVersion.get(table.version);
    if (existing) {
      if (existing.fingerprint !== table.fingerprint) {
        throw new ReconError(CODES.E_TZVER,
          `version ${table.version} of purpose ${purpose} already registered with different content`);
      }
      return existing; // idempotent hot reload
    }
    byVersion.set(table.version, table);
    return table;
  }

  get(purpose, version) {
    const byVersion = this.tables.get(purpose);
    const table = byVersion && byVersion.get(version);
    if (!table) {
      throw new ReconError(CODES.E_TZVER,
        `no table registered for purpose ${purpose} version ${version}`);
    }
    return table;
  }

  versions(purpose) {
    const byVersion = this.tables.get(purpose);
    return byVersion ? [...byVersion.keys()] : [];
  }
}

module.exports = { PURPOSES, TzRegistry, normalizeTable, stableStringify };

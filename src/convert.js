'use strict';

const { ReconError, CODES } = require('./errors');
const {
  MS_PER_MIN, civilToMs, msToCivil, formatLocal, formatUtc,
  parseLocalIso, localDayOf,
} = require('./time');

const POLICIES = Object.freeze(['strict', 'earlier', 'later']);

function getZone(table, zoneName) {
  const zone = table.zones.get(zoneName);
  if (!zone) {
    throw new ReconError(CODES.E_TZVER,
      `zone ${zoneName} not present in table version ${table.version}`);
  }
  return zone;
}

// Offset in effect at utcMs: the last transition at or before utcMs.
// Instants before the first transition use the first transition's offset.
function offsetAt(table, zoneName, utcMs) {
  const { transitions } = getZone(table, zoneName);
  let lo = 0;
  let hi = transitions.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (transitions[mid].utcMs <= utcMs) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return transitions[idx].offsetMinutes;
}

function utcToLocal(table, zoneName, utcMs) {
  const offsetMinutes = offsetAt(table, zoneName, utcMs);
  const localMs = utcMs + offsetMinutes * MS_PER_MIN;
  const civil = msToCivil(localMs);
  return {
    utcMs,
    localMs,
    offsetMinutes,
    iso: formatLocal(civil),
    day: localDayOf(localMs),
  };
}

// All UTC instants mapping to the given local civil ms under this table.
function localToUtcCandidates(table, zoneName, localMs) {
  const { transitions } = getZone(table, zoneName);
  const offsets = [...new Set(transitions.map((t) => t.offsetMinutes))];
  const out = [];
  for (const o of offsets) {
    const cand = localMs - o * MS_PER_MIN;
    if (offsetAt(table, zoneName, cand) === o) out.push(cand);
  }
  out.sort((a, b) => a - b);
  return out;
}

// For a nonexistent local time, find the surrounding gap boundaries.
function gapBoundaries(table, zoneName, localMs) {
  const { transitions } = getZone(table, zoneName);
  for (const tr of transitions) {
    const before = utcToLocal(table, zoneName, tr.utcMs - 1).localMs;
    const after = utcToLocal(table, zoneName, tr.utcMs).localMs;
    if (before < localMs && localMs < after) {
      return { gapStartUtcMs: tr.utcMs, beforeLocalMs: before, afterLocalMs: after };
    }
  }
  return null;
}

function checkPolicy(policy) {
  if (!POLICIES.includes(policy)) {
    throw new ReconError(CODES.E_POLICY,
      `unknown policy ${JSON.stringify(policy)}; expected one of ${POLICIES.join(', ')}`);
  }
}

// Resolve a local timestamp to UTC under the given policy, recording evidence.
// evidence (optional array) receives an entry for every non-unique resolution.
function localToUtc(table, zoneName, localIso, policy, evidence) {
  checkPolicy(policy);
  const localMs = civilToMs(parseLocalIso(localIso));
  const cands = localToUtcCandidates(table, zoneName, localMs);

  if (cands.length === 1) {
    return { utcMs: cands[0], resolution: 'unique' };
  }

  if (cands.length >= 2) {
    const rec = {
      type: 'ambiguous-local',
      tableVersion: table.version,
      zone: zoneName,
      local: localIso,
      policy,
      candidatesUtc: cands.map(formatUtc),
    };
    if (policy === 'strict') {
      throw new ReconError(CODES.E_AMBIG,
        `local time ${localIso} is ambiguous in ${zoneName} (${table.version})`, rec);
    }
    const picked = policy === 'earlier' ? cands[0] : cands[cands.length - 1];
    rec.resolvedUtc = formatUtc(picked);
    if (evidence) evidence.push(rec);
    return { utcMs: picked, resolution: `ambiguous-${policy}` };
  }

  // Nonexistent local time (gap).
  const gap = gapBoundaries(table, zoneName, localMs);
  const rec = {
    type: 'nonexistent-local',
    tableVersion: table.version,
    zone: zoneName,
    local: localIso,
    policy,
    gap: gap ? {
      lastValidUtc: formatUtc(gap.gapStartUtcMs - 1),
      firstValidUtc: formatUtc(gap.gapStartUtcMs),
    } : null,
  };
  if (policy === 'strict') {
    throw new ReconError(CODES.E_AMBIG,
      `local time ${localIso} does not exist in ${zoneName} (${table.version})`, rec);
  }
  // earlier -> last valid instant before the gap; later -> first valid instant after it.
  const picked = policy === 'earlier' ? gap.gapStartUtcMs - 1 : gap.gapStartUtcMs;
  rec.resolvedUtc = formatUtc(picked);
  if (evidence) evidence.push(rec);
  return { utcMs: picked, resolution: `nonexistent-${policy}` };
}

module.exports = {
  POLICIES, offsetAt, utcToLocal, localToUtc, localToUtcCandidates, gapBoundaries,
};

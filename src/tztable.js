// Versioned timezone tables supplied as input data (offline, no system tzdb).
//
// Format:
//   {
//     "version": "2024a",
//     "zones": {
//       "America/New_York": {
//         "segments": [
//           { "utcStart": "2024-01-01T00:00Z", "offsetMinutes": -300 },
//           { "utcStart": "2024-03-10T07:00Z", "offsetMinutes": -240 }
//         ]
//       }
//     }
//   }
// Each segment covers the half-open UTC interval [utcStart, next.utcStart);
// the last segment is open-ended. Within a segment local = utc + offsetMinutes.
import { errInput, errTzUnknown, errGap, errOverlap } from './errors.js';
import { parseUtc, formatLocal, formatUtc } from './civil.js';

export function loadTzTable(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errInput('tz table must be an object');
  }
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw errInput('tz table: "version" must be a non-empty string');
  }
  if (raw.zones === null || typeof raw.zones !== 'object' || Array.isArray(raw.zones)) {
    throw errInput('tz table: "zones" must be an object');
  }
  const zones = new Map();
  for (const [name, zoneRaw] of Object.entries(raw.zones)) {
    zones.set(name, compileZone(name, zoneRaw));
  }
  return { version: raw.version, zones };
}

function compileZone(name, raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw errInput(`tz zone ${name}: "segments" must be a non-empty array`);
  }
  const segments = raw.segments.map((seg, i) => {
    if (seg === null || typeof seg !== 'object') throw errInput(`tz zone ${name}: segment ${i} must be an object`);
    if (!Number.isInteger(seg.offsetMinutes) || seg.offsetMinutes < -840 || seg.offsetMinutes > 840) {
      throw errInput(`tz zone ${name}: segment ${i} has invalid offsetMinutes`);
    }
    return { utcStart: parseUtc(seg.utcStart, `tz zone ${name} segment ${i} utcStart`), offsetMinutes: seg.offsetMinutes };
  });
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].utcStart <= segments[i - 1].utcStart) {
      throw errInput(`tz zone ${name}: segments must be strictly increasing by utcStart`);
    }
    if (segments[i].offsetMinutes === segments[i - 1].offsetMinutes) {
      throw errInput(`tz zone ${name}: adjacent segments ${i - 1}/${i} share an offset; merge them`);
    }
  }
  return { segments };
}

function getZone(table, zone) {
  const z = table.zones.get(zone);
  if (!z) throw errTzUnknown(`unknown timezone ${JSON.stringify(zone)}`, { zone, known: [...table.zones.keys()] });
  return z;
}

// Resolve an unzoned local minute to UTC. Exactly one segment must claim it:
// zero claims => the local time never happened (spring-forward gap);
// two claims  => the local time happened twice (fall-back overlap).
export function resolveLocal(table, zone, localMin) {
  const { segments } = getZone(table, zone);
  const hits = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const utcEnd = i + 1 < segments.length ? segments[i + 1].utcStart : Number.POSITIVE_INFINITY;
    const localStart = seg.utcStart + seg.offsetMinutes;
    const localEnd = utcEnd === Number.POSITIVE_INFINITY ? utcEnd : utcEnd + seg.offsetMinutes;
    if (localMin >= localStart && localMin < localEnd) {
      hits.push({ utcMin: localMin - seg.offsetMinutes, offsetMinutes: seg.offsetMinutes });
    }
  }
  const local = formatLocal(localMin);
  if (hits.length === 0) {
    throw errGap(`local time ${local} does not exist in ${zone} (DST gap)`, { zone, local });
  }
  if (hits.length > 1) {
    throw errOverlap(`local time ${local} is ambiguous in ${zone} (DST overlap)`, {
      zone,
      local,
      candidates: hits.map((h) => ({ utc: formatUtc(h.utcMin), offsetMinutes: h.offsetMinutes })),
    });
  }
  return hits[0];
}

// Offset in effect at a UTC instant (for rendering intervals in local terms).
export function offsetAtUtc(table, zone, utcMin) {
  const { segments } = getZone(table, zone);
  if (utcMin < segments[0].utcStart) {
    throw errInput(`instant ${formatUtc(utcMin)} predates tz table coverage for ${zone}`);
  }
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].utcStart <= utcMin) lo = mid;
    else hi = mid - 1;
  }
  return segments[lo].offsetMinutes;
}

import { CodedError, ERRORS } from './errors.js';

const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

// Explicit UTC-offset table per zone. Each rule takes effect at a given UTC
// instant (`atUtc`, epoch ms) and sets `offsetMinutes` (local = UTC + offset).
// No system timezone is ever consulted.
export class TimezoneTable {
  constructor() {
    this.zones = new Map();
  }

  defineZone(zone, rules) {
    if (typeof zone !== 'string' || zone.length === 0) {
      throw new CodedError(ERRORS.BAD_COMMAND, 'zone must be a non-empty string');
    }
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new CodedError(ERRORS.OFFSET_TABLE_CONFLICT,
        `zone ${zone}: offset table must contain at least one rule`);
    }
    const norm = rules.map((r, i) => {
      if (!r || !Number.isFinite(r.atUtc) || !Number.isInteger(r.offsetMinutes)) {
        throw new CodedError(ERRORS.OFFSET_TABLE_CONFLICT,
          `zone ${zone}: rule #${i} needs finite atUtc and integer offsetMinutes`);
      }
      if (r.offsetMinutes < MIN_OFFSET_MINUTES || r.offsetMinutes > MAX_OFFSET_MINUTES) {
        throw new CodedError(ERRORS.OFFSET_TABLE_CONFLICT,
          `zone ${zone}: rule #${i} offset ${r.offsetMinutes}min outside [-720, 840]`);
      }
      return { atUtc: r.atUtc, offsetMs: r.offsetMinutes * 60000 };
    });
    norm.sort((a, b) => a.atUtc - b.atUtc);
    for (let i = 1; i < norm.length; i++) {
      if (norm[i].atUtc === norm[i - 1].atUtc) {
        throw new CodedError(ERRORS.OFFSET_TABLE_CONFLICT,
          `zone ${zone}: two rules take effect at the same UTC instant ${norm[i].atUtc}`);
      }
    }
    // The local instant at which each rule takes effect (atUtc + offset) must be
    // strictly increasing, otherwise the local->UTC mapping is ambiguous.
    for (let i = 1; i < norm.length; i++) {
      const prevLocal = norm[i - 1].atUtc + norm[i - 1].offsetMs;
      const curLocal = norm[i].atUtc + norm[i].offsetMs;
      if (curLocal <= prevLocal) {
        throw new CodedError(ERRORS.OFFSET_TABLE_CONFLICT,
          `zone ${zone}: rule at utc=${norm[i].atUtc} makes local effective times non-monotonic`);
      }
    }
    this.zones.set(zone, norm.map(r => ({
      atUtc: r.atUtc,
      offsetMs: r.offsetMs,
      localFrom: r.atUtc + r.offsetMs,
    })));
    return { zone, ruleCount: norm.length };
  }

  hasZone(zone) {
    return this.zones.has(zone);
  }

  // Convert a naive local wall-clock millisecond value to UTC epoch ms.
  localToUtc(zone, localMs) {
    const rules = this.zones.get(zone);
    if (!rules) {
      throw new CodedError(ERRORS.UNKNOWN_TIMEZONE, `unknown timezone zone: ${JSON.stringify(zone)}`);
    }
    // Last rule whose local effective instant is <= localMs.
    let lo = 0, hi = rules.length - 1, pick = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rules[mid].localFrom <= localMs) { pick = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (pick === -1) {
      throw new CodedError(ERRORS.LOCAL_TIME_OUT_OF_TABLE,
        `zone ${zone}: local time ${localMs} precedes the first offset rule`);
    }
    return localMs - rules[pick].offsetMs;
  }
}

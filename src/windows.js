'use strict';

const { EngineError } = require('./errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DURATION_MINUTES = 7 * 24 * 60;

function illegal(message) {
  return new EngineError('ILLEGAL_PERIOD', message);
}

function parseClock(value) {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// timezones: { "Asia/Shanghai": 480 } or
// { "Test/Zone": [{ from: ISO, offsetMinutes: n }, ...] } (UTC-ordered segments)
function normalizeTimezones(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EngineError('VALIDATION', 'timezones must be an object');
  }
  const table = {};
  for (const [tz, spec] of Object.entries(input)) {
    const raw = typeof spec === 'number'
      ? [{ from: '1970-01-01T00:00:00.000Z', offsetMinutes: spec }]
      : spec;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new EngineError('VALIDATION', `timezone ${tz}: offset segments required`);
    }
    table[tz] = raw.map((s) => {
      const fromMs = Date.parse(s && s.from);
      if (Number.isNaN(fromMs)) {
        throw new EngineError('VALIDATION', `timezone ${tz}: bad segment "from"`);
      }
      if (!Number.isFinite(s.offsetMinutes) || Math.abs(s.offsetMinutes) > 14 * 60) {
        throw new EngineError('VALIDATION', `timezone ${tz}: bad offsetMinutes`);
      }
      return { fromMs, offsetMinutes: s.offsetMinutes };
    }).sort((a, b) => a.fromMs - b.fromMs);
  }
  return table;
}

function offsetAtUTC(table, tz, utcMs) {
  const segs = table[tz];
  if (!segs) throw illegal(`unknown timezone: ${tz}`);
  let off = segs[0].offsetMinutes;
  for (const s of segs) {
    if (s.fromMs <= utcMs) off = s.offsetMinutes;
    else break;
  }
  return off;
}

function utcToLocalMs(table, tz, utcMs) {
  return utcMs + offsetAtUTC(table, tz, utcMs) * 60000;
}

function localToUTCMs(table, tz, localMs) {
  const segs = table[tz];
  if (!segs) throw illegal(`unknown timezone: ${tz}`);
  for (const s of segs) {
    const candidate = localMs - s.offsetMinutes * 60000;
    if (offsetAtUTC(table, tz, candidate) === s.offsetMinutes) return candidate;
  }
  return localMs - segs[segs.length - 1].offsetMinutes * 60000;
}

function validateRule(rule, table) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw illegal('rule must be an object');
  }
  if (typeof rule.id !== 'string' || rule.id === '') {
    throw illegal('rule.id is required');
  }
  if (rule.kind !== 'daily' && rule.kind !== 'weekly') {
    throw illegal(`rule ${rule.id}: kind must be "daily" or "weekly"`);
  }
  let weekday = null;
  if (rule.kind === 'weekly') {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
      throw illegal(`rule ${rule.id}: weekday must be an integer 0..6`);
    }
    weekday = rule.weekday;
  }
  const startMinutes = parseClock(rule.start);
  if (startMinutes === null) {
    throw illegal(`rule ${rule.id}: start must be "HH:MM" (00:00..23:59)`);
  }
  if (!Number.isInteger(rule.durationMinutes)
      || rule.durationMinutes <= 0
      || rule.durationMinutes > MAX_DURATION_MINUTES) {
    throw illegal(`rule ${rule.id}: durationMinutes must be an integer 1..${MAX_DURATION_MINUTES}`);
  }
  if (!table[rule.timezone]) {
    throw illegal(`rule ${rule.id}: unknown timezone ${rule.timezone}`);
  }
  let validFromMs = -Infinity;
  let validToMs = Infinity;
  if (rule.validFrom !== undefined) {
    validFromMs = Date.parse(rule.validFrom);
    if (Number.isNaN(validFromMs)) throw illegal(`rule ${rule.id}: bad validFrom`);
  }
  if (rule.validTo !== undefined) {
    validToMs = Date.parse(rule.validTo);
    if (Number.isNaN(validToMs)) throw illegal(`rule ${rule.id}: bad validTo`);
  }
  if (validFromMs > validToMs) {
    throw illegal(`rule ${rule.id}: validFrom is after validTo`);
  }
  return {
    id: rule.id,
    kind: rule.kind,
    weekday,
    startMinutes,
    durationMinutes: rule.durationMinutes,
    timezone: rule.timezone,
    validFromMs,
    validToMs,
  };
}

function normalizeHolidays(input, table) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EngineError('VALIDATION', 'holidays must be an object');
  }
  const cancel = (input.cancel || []).map((d) => {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw illegal(`holiday cancel date must be YYYY-MM-DD, got: ${d}`);
    }
    return d;
  });
  const add = (input.add || []).map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw illegal(`holidays.add[${i}] must be an object`);
    if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      throw illegal(`holidays.add[${i}]: date must be YYYY-MM-DD`);
    }
    const startMinutes = parseClock(entry.start);
    if (startMinutes === null) throw illegal(`holidays.add[${i}]: start must be "HH:MM"`);
    if (!Number.isInteger(entry.durationMinutes)
        || entry.durationMinutes <= 0
        || entry.durationMinutes > MAX_DURATION_MINUTES) {
      throw illegal(`holidays.add[${i}]: durationMinutes must be 1..${MAX_DURATION_MINUTES}`);
    }
    if (!table[entry.timezone]) throw illegal(`holidays.add[${i}]: unknown timezone ${entry.timezone}`);
    return { date: entry.date, startMinutes, durationMinutes: entry.durationMinutes, timezone: entry.timezone };
  });
  return { cancel, add };
}

// Enumerate inspection windows (UTC, half-open [start, end)) overlapping [fromMs, toMs).
function computeWindows(config, fromMs, toMs) {
  const out = [];
  for (const rule of config.rules) {
    const tz = rule.timezone;
    let day = Math.floor(utcToLocalMs(config.timezones, tz, fromMs) / DAY_MS) * DAY_MS;
    const endLocal = utcToLocalMs(config.timezones, tz, toMs);
    while (day <= endLocal) {
      const applies = rule.kind === 'daily' || new Date(day).getUTCDay() === rule.weekday;
      if (applies) {
        const dateStr = new Date(day).toISOString().slice(0, 10);
        if (!config.holidays.cancel.includes(dateStr)) {
          const start = localToUTCMs(config.timezones, tz, day + rule.startMinutes * 60000);
          const end = start + rule.durationMinutes * 60000;
          if (end > fromMs && start < toMs && start >= rule.validFromMs && start < rule.validToMs) {
            out.push({ start, end, ruleId: rule.id });
          }
        }
      }
      day += DAY_MS;
    }
  }
  for (const add of config.holidays.add) {
    const localDay = Date.parse(`${add.date}T00:00:00.000Z`);
    const start = localToUTCMs(config.timezones, add.timezone, localDay + add.startMinutes * 60000);
    const end = start + add.durationMinutes * 60000;
    if (end > fromMs && start < toMs) out.push({ start, end, ruleId: 'holiday-add' });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out.filter((w, i) => i === 0 || w.start !== out[i - 1].start || w.end !== out[i - 1].end);
}

function isInWindow(config, tMs) {
  const lookback = (MAX_DURATION_MINUTES + 2 * 24 * 60) * 60000;
  return computeWindows(config, tMs - lookback, tMs + 1)
    .some((w) => w.start <= tMs && tMs < w.end);
}

module.exports = {
  DAY_MS,
  MAX_DURATION_MINUTES,
  normalizeTimezones,
  validateRule,
  normalizeHolidays,
  computeWindows,
  isInWindow,
  offsetAtUTC,
  utcToLocalMs,
  localToUTCMs,
};

'use strict';

const { ReconError, CODES } = require('./errors');

const MS_PER_MIN = 60000;
const MS_PER_DAY = 86400000;

// Howard Hinnant's days_from_civil: days since 1970-01-01.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = (m + 9) % 12;   // [0, 11]
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const dm = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dm[m - 1];
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

// civil {y,mo,d,h,mi,s,ms} -> epoch-like ms (no timezone)
function civilToMs(c) {
  return daysFromCivil(c.y, c.mo, c.d) * MS_PER_DAY +
    c.h * 3600000 + c.mi * 60000 + c.s * 1000 + (c.ms || 0);
}

function msToCivil(ms) {
  const days = Math.floor(ms / MS_PER_DAY);
  let rem = ms - days * MS_PER_DAY;
  const { y, m, d } = civilFromDays(days);
  const h = Math.floor(rem / 3600000); rem -= h * 3600000;
  const mi = Math.floor(rem / 60000); rem -= mi * 60000;
  const s = Math.floor(rem / 1000); rem -= s * 1000;
  return { y, mo: m, d, h, mi, s, ms: rem };
}

function formatLocal(c) {
  return `${pad(c.y, 4)}-${pad(c.mo, 2)}-${pad(c.d, 2)}T${pad(c.h, 2)}:${pad(c.mi, 2)}:${pad(c.s, 2)}`;
}

function formatUtc(ms) {
  const c = msToCivil(ms);
  const frac = c.ms ? `.${pad(c.ms, 3)}` : '';
  return formatLocal(c) + frac + 'Z';
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

function parseLocalIso(str) {
  const m = LOCAL_RE.exec(str);
  if (!m) throw new ReconError(CODES.E_POLICY, `invalid local timestamp: ${str}`);
  const c = {
    y: +m[1], mo: +m[2], d: +m[3],
    h: +m[4], mi: +m[5], s: +m[6],
    ms: m[7] ? +m[7].padEnd(3, '0') : 0,
  };
  if (c.mo < 1 || c.mo > 12 || c.d < 1 || c.d > daysInMonth(c.y, c.mo) ||
      c.h > 23 || c.mi > 59 || c.s > 59) {
    throw new ReconError(CODES.E_POLICY, `invalid local timestamp: ${str}`);
  }
  return c;
}

const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

// Parse a UTC timestamp. Seconds == 60 is a "leap-second-style" boundary and is
// only accepted when the given leapMap (a Map, or null) carries an explicit
// entry for it.
function parseUtcIso(str, leapMap) {
  const m = UTC_RE.exec(str);
  if (!m) throw new ReconError(CODES.E_POLICY, `invalid UTC timestamp: ${str}`);
  const sec = +m[6];
  if (sec === 60) {
    const mapped = leapMap && leapMap.get(str);
    if (mapped === undefined) {
      throw new ReconError(CODES.E_TZVER,
        `leap-style boundary ${str} has no explicit mapping in the given table`);
    }
    return mapped; // leapMap values are stored as resolved epoch ms
  }
  const c = {
    y: +m[1], mo: +m[2], d: +m[3],
    h: +m[4], mi: +m[5], s: sec,
    ms: m[7] ? +m[7].padEnd(3, '0') : 0,
  };
  if (c.mo < 1 || c.mo > 12 || c.d < 1 || c.d > daysInMonth(c.y, c.mo) ||
      c.h > 23 || c.mi > 59 || c.s > 59) {
    throw new ReconError(CODES.E_POLICY, `invalid UTC timestamp: ${str}`);
  }
  return civilToMs(c);
}

function localDayOf(localMs) {
  const { y, m, d } = civilFromDays(Math.floor(localMs / MS_PER_DAY));
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

module.exports = {
  MS_PER_MIN, MS_PER_DAY,
  daysFromCivil, civilFromDays, daysInMonth,
  civilToMs, msToCivil,
  formatLocal, formatUtc,
  parseLocalIso, parseUtcIso, localDayOf,
};

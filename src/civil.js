// Civil-date arithmetic at minute precision, timezone-free.
// All "local minutes" are minutes since 1970-01-01T00:00 (proleptic Gregorian),
// interpreted without any zone; conversion to UTC happens only via tz tables.
import { errInput } from './errors.js';

export function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z) {
  z += 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function checkDate(y, m, d, what) {
  if (m < 1 || m > 12) throw errInput(`${what}: month out of range`);
  const dim = m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1];
  if (d < 1 || d > dim) throw errInput(`${what}: day out of range`);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatDate(dayNum) {
  const { y, m, d } = civilFromDays(dayNum);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function parseDate(text, what = 'date') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '');
  if (!m) throw errInput(`${what}: expected YYYY-MM-DD, got ${JSON.stringify(text)}`);
  const [, y, mo, d] = m.map(Number);
  checkDate(y, mo, d, what);
  return daysFromCivil(y, mo, d);
}

export function parseHhMm(text, what = 'time') {
  const m = /^(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) throw errInput(`${what}: expected HH:MM, got ${JSON.stringify(text)}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw errInput(`${what}: out of range`);
  return hh * 60 + mm;
}

// Local timestamp "YYYY-MM-DDTHH:MM" (minute precision, no zone designator).
export function parseLocal(text, what = 'localTime') {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) throw errInput(`${what}: expected YYYY-MM-DDTHH:MM, got ${JSON.stringify(text)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  checkDate(y, mo, d, what);
  if (hh > 23 || mm > 59) throw errInput(`${what}: time out of range`);
  return daysFromCivil(y, mo, d) * 1440 + hh * 60 + mm;
}

export function formatLocal(localMin) {
  const day = Math.floor(localMin / 1440);
  const tod = localMin - day * 1440;
  return `${formatDate(day)}T${pad(Math.floor(tod / 60))}:${pad(tod % 60)}`;
}

// UTC instant "YYYY-MM-DDTHH:MM(:SS)?Z" -> minutes since epoch. Seconds must be 0.
export function parseUtc(text, what = 'utc') {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?Z$/.exec(text ?? '');
  if (!m) throw errInput(`${what}: expected YYYY-MM-DDTHH:MMZ, got ${JSON.stringify(text)}`);
  if (m[2] !== undefined && m[2] !== '00') {
    throw errInput(`${what}: sub-minute precision is not supported`);
  }
  const ms = Date.parse(m[1] + ':00Z');
  if (Number.isNaN(ms)) throw errInput(`${what}: invalid instant`);
  return ms / 60000;
}

export function formatUtc(utcMin) {
  return new Date(utcMin * 60000).toISOString().slice(0, 16) + 'Z';
}

export function dateOfLocal(localMin) {
  return Math.floor(localMin / 1440);
}

export function timeOfDay(localMin) {
  return localMin - Math.floor(localMin / 1440) * 1440;
}

// 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday.
export function dayOfWeek(dayNum) {
  return (((dayNum + 4) % 7) + 7) % 7;
}

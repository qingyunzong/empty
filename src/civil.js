import { CodedError, ERRORS } from './errors.js';

// Days-from-civil (Howard Hinnant's algorithm), no system timezone involved.
export function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

// Parse a naive local timestamp "YYYY-MM-DDTHH:mm:ss[.fff]" into milliseconds
// on a synthetic "wall clock" axis. Never touches the system timezone.
export function parseLocalToMs(text) {
  if (typeof text !== 'string') {
    throw new CodedError(ERRORS.BAD_COMMAND, `local time must be a string, got ${typeof text}`);
  }
  const m = LOCAL_RE.exec(text.trim());
  if (!m) {
    throw new CodedError(ERRORS.BAD_COMMAND, `invalid local time format: ${JSON.stringify(text)}`);
  }
  const [, ys, mos, ds, hs, mis, ss, fs] = m;
  const year = Number(ys), month = Number(mos), day = Number(ds);
  const hour = Number(hs), minute = Number(mis), second = Number(ss);
  const frac = fs ? Number(fs.padEnd(3, '0')) : 0;
  const dim = month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (month < 1 || month > 12 || day < 1 || day > dim ||
      hour > 23 || minute > 59 || second > 59) {
    throw new CodedError(ERRORS.BAD_COMMAND, `local time out of range: ${JSON.stringify(text)}`);
  }
  return daysFromCivil(year, month, day) * 86400000 +
    hour * 3600000 + minute * 60000 + second * 1000 + frac;
}

// Format UTC milliseconds as an ISO-8601 UTC string (pure arithmetic).
export function formatUtcMs(ms) {
  const neg = ms < 0;
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400000);
  let rem = abs - days * 86400000;
  const hour = Math.floor(rem / 3600000); rem -= hour * 3600000;
  const minute = Math.floor(rem / 60000); rem -= minute * 60000;
  const second = Math.floor(rem / 1000);
  const frac = rem - second * 1000;
  // civil-from-days
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mo = mp + (mp < 10 ? 3 : -9);
  const yr = mo <= 2 ? y + 1 : y;
  const p = (n, w) => String(n).padStart(w, '0');
  const out = `${p(yr, 4)}-${p(mo, 2)}-${p(d, 2)}T${p(hour, 2)}:${p(minute, 2)}:${p(second, 2)}.${p(frac, 3)}Z`;
  return neg ? `-${out}` : out;
}

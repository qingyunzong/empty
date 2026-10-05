// Minute-resolution civil time helpers. All "utc minutes" are integer minutes
// since 1970-01-01T00:00Z. All "local minutes" are dayNumber*1440 + minuteOfDay
// in some zone's local civil clock.

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
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [m <= 2 ? y + 1 : y, m, d];
}

const pad = (n) => String(n).padStart(2, '0');

export function dateToDayNumber(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`invalid date: ${dateStr}`);
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function dayNumberToDate(dayNum) {
  const [y, m, d] = civilFromDays(dayNum);
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

// "YYYY-MM-DDTHH:MM" (optionally ":SS", seconds must be 00) -> local absolute minutes
export function parseLocalMinutes(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str);
  if (!m) throw new Error(`invalid local datetime: ${str}`);
  if (m[6] !== undefined && m[6] !== '00') throw new Error(`sub-minute precision not supported: ${str}`);
  const day = daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
  const minute = Number(m[4]) * 60 + Number(m[5]);
  if (minute >= 1440) throw new Error(`invalid time of day: ${str}`);
  return day * 1440 + minute;
}

// ISO instant with explicit Z or +/-HH:MM offset -> utc minutes
export function parseUtcMinutes(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/.exec(str);
  if (!m) throw new Error(`invalid utc datetime (offset required): ${str}`);
  if (m[6] !== undefined && m[6] !== '00') throw new Error(`sub-minute precision not supported: ${str}`);
  const day = daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
  let minutes = day * 1440 + Number(m[4]) * 60 + Number(m[5]);
  if (m[7] !== 'Z') {
    const sign = m[7][0] === '-' ? -1 : 1;
    const off = sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(4, 6)));
    minutes -= off;
  }
  return minutes;
}

export function formatLocalMinutes(localMin) {
  const day = Math.floor(localMin / 1440);
  const mod = localMin - day * 1440;
  return `${dayNumberToDate(day)}T${pad(Math.floor(mod / 60))}:${pad(mod % 60)}`;
}

export function formatUtcMinutes(utcMin) {
  return `${formatLocalMinutes(utcMin)}Z`;
}

export function parseHHMM(str) {
  const m = /^(\d{2}):(\d{2})$/.exec(str);
  if (!m) throw new Error(`invalid HH:MM: ${str}`);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v > 1440) throw new Error(`invalid HH:MM: ${str}`);
  return v;
}

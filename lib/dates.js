// Calendar arithmetic on civil dates (YYYY-MM-DD), implemented directly on
// the proleptic Gregorian calendar so results are exact across leap-year
// boundaries and independent of Date/timezone behaviour.

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year, month) {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

export function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

// Howard Hinnant's days_from_civil / civil_from_days algorithms.
export function toDays(date) {
  let year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const fullYear = year + (month <= 2 ? 1 : 0);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(fullYear, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function addDays(date, n) {
  return fromDays(toDays(date) + n);
}

export function compareDates(a, b) {
  return toDays(a) - toDays(b);
}

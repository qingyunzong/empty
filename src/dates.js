// Deterministic, UTC-only, day-precision date math. No wall clock, no local TZ.
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year, month) {
  return month === 2 && isLeap(year) ? 29 : DAYS[month - 1];
}

export function parse(iso) {
  const m = RE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function isValidDate(iso) {
  return typeof iso === 'string' && parse(iso) !== null;
}

export function fmt(y, m, d) {
  const p = (v, n) => String(v).padStart(n, '0');
  return `${p(y, 4)}-${p(m, 2)}-${p(d, 2)}`;
}

function toUTC(iso) {
  const { y, m, d } = parse(iso);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso, n) {
  const dt = new Date(toUTC(iso) + n * 86400000);
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// Month arithmetic anchored on the original day-of-month, clamped to the
// target month's last day (2024-01-31 +1mo -> 2024-02-29, +12mo -> 2025-01-31).
export function addMonthsClamped(iso, n) {
  const { y, m, d } = parse(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function weekday(iso) {
  return new Date(toUTC(iso)).getUTCDay(); // 0=Sun .. 6=Sat
}

export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

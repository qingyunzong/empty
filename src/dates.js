// All dates are ISO calendar dates (YYYY-MM-DD), compared lexicographically.

export function isValidDate(s) {
  return (
    typeof s === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  );
}

export function addDays(s, days) {
  const t = Date.parse(`${s}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function periodKey(date, period = 'monthly') {
  switch (period) {
    case 'daily':
      return date;
    case 'monthly':
      return date.slice(0, 7);
    case 'yearly':
      return date.slice(0, 4);
    case 'none':
      return 'all';
    default:
      throw new Error(`unknown budget period: ${period}`);
  }
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

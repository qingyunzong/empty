// Deterministic period-rule expansion. All arithmetic in UTC (fixed timezone).

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) throw new EngineError('BAD_DATE', `invalid date: ${s}`);
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new EngineError('BAD_DATE', `invalid calendar date: ${s}`);
  }
  return { y, m: mo, d };
}

const pad = (n) => String(n).padStart(2, '0');
export const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(dateStr, n) {
  const { y, m, d } = parseDate(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function dayOfWeek(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const FREQS = new Set(['daily', 'weekly', 'monthly', 'yearly']);

// Yields ISO dates in [start, end]. Leap rule: clamp day-of-month to the
// month's last day (2024-01-31 monthly -> 2024-02-29; yearly 2024-02-29 ->
// 2025-02-28). Throws BAD_RANGE when end < start; never a silent empty plan.
export function* occurrences(rule) {
  const { freq, start, end } = rule;
  const interval = rule.interval ?? 1;
  if (!FREQS.has(freq)) throw new EngineError('BAD_FREQ', `unknown freq: ${freq}`);
  if (!Number.isInteger(interval) || interval < 1) {
    throw new EngineError('BAD_INTERVAL', `interval must be a positive integer`);
  }
  parseDate(start);
  parseDate(end);
  if (end < start) {
    throw new EngineError('BAD_RANGE', `end ${end} is before start ${start}`);
  }
  const s = parseDate(start);
  if (freq === 'daily' || freq === 'weekly') {
    const step = freq === 'daily' ? interval : 7 * interval;
    for (let d = start; d <= end; d = addDays(d, step)) yield d;
    return;
  }
  if (freq === 'monthly') {
    let y = s.y, m = s.m;
    for (;;) {
      const ds = fmt(y, m, Math.min(s.d, daysInMonth(y, m)));
      if (ds > end) return;
      yield ds;
      m += interval;
      while (m > 12) { m -= 12; y += 1; }
    }
  }
  // yearly
  for (let y = s.y;; y += interval) {
    const ds = fmt(y, s.m, Math.min(s.d, daysInMonth(y, s.m)));
    if (ds > end) return;
    yield ds;
  }
}

'use strict';
const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`invalid date: ${s}`);
  const t = Date.parse(`${s}T00:00:00.000Z`);
  if (Number.isNaN(t)) throw new Error(`invalid date: ${s}`);
  return t;
}

function fmt(t) {
  return new Date(t).toISOString().slice(0, 10);
}

class Calendar {
  constructor(version, holidays = []) {
    if (typeof version !== 'string' || !version) throw new Error('calendar: version required');
    this.version = version;
    this.holidays = new Set(holidays);
    for (const h of this.holidays) parseDate(h);
  }
  isBusinessDay(d) {
    const t = parseDate(d);
    const dow = new Date(t).getUTCDay();
    return dow !== 0 && dow !== 6 && !this.holidays.has(d);
  }
  adjust(d) {
    let t = parseDate(d);
    while (!this.isBusinessDay(fmt(t))) t += DAY_MS;
    return fmt(t);
  }
}

module.exports = { Calendar, parseDate, fmt };

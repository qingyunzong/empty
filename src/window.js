import { QError } from './errors.js';

const TIME_RE = /^(\d{2}):(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseTimeOfDay(value) {
  const match = TIME_RE.exec(typeof value === 'string' ? value : '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new QError('ILLEGAL_PERIOD', `invalid time-of-day "${value}"`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Periodic local QC window: weekly rules in local wall-clock time, holiday
// exceptions by local date, evaluated through the timezone table.
export class QualityWindow {
  constructor(config, timezones) {
    if (!config || typeof config !== 'object') {
      throw new QError('ILLEGAL_PERIOD', 'window config is required');
    }
    const { zone, weekly, holidays = [] } = config;
    if (!timezones.has(zone)) {
      throw new QError('ILLEGAL_PERIOD', `window references unknown timezone "${zone}"`);
    }
    if (!Array.isArray(weekly) || weekly.length === 0) {
      throw new QError('ILLEGAL_PERIOD', 'window needs at least one weekly rule');
    }
    this.zone = zone;
    this.timezones = timezones;
    this.rules = weekly.map((rule) => {
      if (!rule || typeof rule !== 'object') {
        throw new QError('ILLEGAL_PERIOD', 'window rule must be an object');
      }
      const { days, start, end } = rule;
      if (!Array.isArray(days) || days.length === 0 ||
          days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new QError('ILLEGAL_PERIOD', 'window rule days must be integers 0..6 (0 = Sunday)');
      }
      const startMin = parseTimeOfDay(start);
      const endMin = parseTimeOfDay(end);
      if (startMin === endMin) {
        throw new QError('ILLEGAL_PERIOD', `zero-length window ${start}..${end}`);
      }
      return { days: new Set(days), start: startMin, end: endMin };
    });
    if (!Array.isArray(holidays)) {
      throw new QError('ILLEGAL_PERIOD', 'holidays must be an array of YYYY-MM-DD');
    }
    this.holidays = new Set(holidays.map((h) => {
      if (!DATE_RE.test(typeof h === 'string' ? h : '')) {
        throw new QError('ILLEGAL_PERIOD', `invalid holiday date "${h}"`);
      }
      return h;
    }));
  }

  contains(utcMs) {
    const localMs = this.timezones.toLocalMs(this.zone, utcMs);
    const local = new Date(localMs);
    const dateStr = local.toISOString().slice(0, 10);
    if (this.holidays.has(dateStr)) return false;
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    const day = local.getUTCDay();
    const prevDay = (day + 6) % 7;
    for (const rule of this.rules) {
      if (rule.start < rule.end) {
        if (rule.days.has(day) && minutes >= rule.start && minutes < rule.end) return true;
      } else {
        // Overnight window, e.g. 22:00..02:00 belongs to the day it starts.
        if (rule.days.has(day) && minutes >= rule.start) return true;
        if (rule.days.has(prevDay) && minutes < rule.end) return true;
      }
    }
    return false;
  }
}

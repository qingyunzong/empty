'use strict';

const WINDOW_SECONDS = 900; // fixed 15-minute windows, aligned to epoch

function windowStart(ts) {
  return Math.floor(ts / WINDOW_SECONDS) * WINDOW_SECONDS;
}

function compareEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sameValues(a, b) {
  return a.uptime === b.uptime && a.downtime === b.downtime && a.unknown === b.unknown;
}

// Interval-based computation of one window for a device's sorted event list.
// State before the first event is null (unknown). An event's state covers
// [event.ts, nextEvent.ts). Pure-unknown windows report null uptime/downtime.
function computeWindow(sortedEvents, wStart) {
  const wEnd = wStart + WINDOW_SECONDS;
  let up = 0;
  let down = 0;
  let unknown = 0;
  let idx = 0;
  let state = null;
  while (idx < sortedEvents.length && sortedEvents[idx].ts <= wStart) {
    state = sortedEvents[idx].state;
    idx += 1;
  }
  let cursor = wStart;
  while (cursor < wEnd) {
    let segEnd = wEnd;
    if (idx < sortedEvents.length && sortedEvents[idx].ts < wEnd) {
      segEnd = sortedEvents[idx].ts;
    }
    const len = segEnd - cursor;
    if (state === 'up') up += len;
    else if (state === 'down') down += len;
    else unknown += len;
    cursor = segEnd;
    while (idx < sortedEvents.length && sortedEvents[idx].ts <= cursor) {
      state = sortedEvents[idx].state;
      idx += 1;
    }
  }
  if (up + down === 0) return { uptime: null, downtime: null, unknown: WINDOW_SECONDS };
  return { uptime: up, downtime: down, unknown };
}

class Aggregator {
  constructor() {
    this.devices = new Map(); // device -> { events: [], ids: Set }
    this.published = new Map(); // `${device}|${window}` -> published row
    this.watermark = null; // max ts ever applied
  }

  restore(state) {
    if (!state) return;
    this.watermark = state.watermark;
    for (const row of state.published || []) {
      this.published.set(`${row.device}|${row.window}`, { ...row });
    }
  }

  snapshot() {
    return { watermark: this.watermark, published: [...this.published.values()] };
  }

  // Insert an event keyed by id (duplicates ignored). Returns whether the
  // event was late (ts below watermark) and the state range it affects.
  addEvent(ev) {
    let dev = this.devices.get(ev.device);
    if (!dev) {
      dev = { events: [], ids: new Set() };
      this.devices.set(ev.device, dev);
    }
    if (dev.ids.has(ev.id)) return { duplicate: true, late: false };
    const late = this.watermark !== null && ev.ts < this.watermark;
    const events = dev.events;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEvents(events[mid], ev) < 0) lo = mid + 1;
      else hi = mid;
    }
    events.splice(lo, 0, ev);
    dev.ids.add(ev.id);
    if (this.watermark === null || ev.ts > this.watermark) this.watermark = ev.ts;
    const next = events[lo + 1] || null;
    return {
      duplicate: false,
      late,
      rangeStart: ev.ts,
      rangeEnd: next ? next.ts : Infinity,
    };
  }

  sortedEvents(device) {
    const dev = this.devices.get(device);
    return dev ? dev.events : [];
  }

  // Published window starts for a device overlapping [start, end).
  publishedWindowsInRange(device, start, end) {
    const out = [];
    for (const row of this.published.values()) {
      if (row.device !== device) continue;
      if (row.window + WINDOW_SECONDS > start && row.window < end) out.push(row.window);
    }
    return out.sort((a, b) => a - b);
  }

  // Recompute a window and reconcile with the published version.
  // kind: 'new' | 'unchanged' | 'corrected' (version bumped, old row retracted).
  publishWindow(device, wStart) {
    const fresh = computeWindow(this.sortedEvents(device), wStart);
    const key = `${device}|${wStart}`;
    const pub = this.published.get(key);
    if (!pub) {
      const entry = { device, window: wStart, ...fresh, version: 1 };
      this.published.set(key, entry);
      return { kind: 'new', entry };
    }
    if (sameValues(pub, fresh)) return { kind: 'unchanged', entry: pub };
    const previous = { ...pub };
    pub.uptime = fresh.uptime;
    pub.downtime = fresh.downtime;
    pub.unknown = fresh.unknown;
    pub.version += 1;
    return { kind: 'corrected', entry: pub, previous };
  }
}

module.exports = { WINDOW_SECONDS, windowStart, compareEvents, computeWindow, Aggregator };

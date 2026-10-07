export const WINDOW_SECONDS = 900; // fixed 15-minute windows

export function windowStart(ts) {
  return Math.floor(ts / WINDOW_SECONDS) * WINDOW_SECONDS;
}

function compareEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Per-device event timeline, kept sorted by (ts, id). State before the first
// event is null (unknown): it counts as neither uptime nor downtime.
export class Timeline {
  constructor() {
    this.events = [];
    this.ids = new Set();
  }

  has(id) {
    return this.ids.has(id);
  }

  // Insert by key (ts, id); duplicate ids are ignored so replays and
  // re-deliveries never double count.
  insert(event) {
    if (this.ids.has(event.id)) return false;
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEvents(this.events[mid], event) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.events.splice(lo, 0, event);
    this.ids.add(event.id);
    return true;
  }

  // State in effect at ts: the state of the latest event with event.ts <= ts,
  // or null before the first event.
  stateAt(ts) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].ts <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? null : this.events[lo - 1].state;
  }
}

// Aggregate one 15-minute window from a timeline.
// uptime + downtime + unknown === WINDOW_SECONDS always.
// A fully unknown window reports uptime/downtime as null.
export function aggregateWindow(timeline, wStart) {
  const wEnd = wStart + WINDOW_SECONDS;
  let up = 0;
  let down = 0;
  let cursor = wStart;
  let state = timeline ? timeline.stateAt(wStart) : null;
  if (timeline) {
    for (const ev of timeline.events) {
      if (ev.ts <= wStart) continue;
      if (ev.ts >= wEnd) break;
      if (state === 'up') up += ev.ts - cursor;
      else if (state === 'down') down += ev.ts - cursor;
      cursor = ev.ts;
      state = ev.state;
    }
  }
  if (state === 'up') up += wEnd - cursor;
  else if (state === 'down') down += wEnd - cursor;
  const unknown = WINDOW_SECONDS - up - down;
  return {
    windowStart: wStart,
    windowEnd: wEnd,
    uptime: unknown === WINDOW_SECONDS ? null : up,
    downtime: unknown === WINDOW_SECONDS ? null : down,
    unknown,
  };
}

// Incremental aggregation engine with watermark, retraction and correction.
// Every published window carries a monotonically increasing version; a late
// event retracts the stale versions of all affected windows and publishes
// corrected ones. Only the latest version per (device, window) is live, so
// nothing is ever counted twice.
export class Aggregator {
  constructor() {
    this.timelines = new Map(); // device -> Timeline
    this.published = new Map(); // `${device}|${windowStart}` -> record
    this.corrections = []; // append-only retract/publish journal
    this.watermark = null;
  }

  insert(event) {
    let timeline = this.timelines.get(event.device);
    if (!timeline) {
      timeline = new Timeline();
      this.timelines.set(event.device, timeline);
    }
    if (!timeline.insert(event)) return { inserted: false, late: false };
    const prevWatermark = this.watermark;
    const late = prevWatermark !== null && event.ts < prevWatermark;
    if (prevWatermark === null || event.ts > prevWatermark) this.watermark = event.ts;
    // Republish every window from the earliest affected one (the event's own
    // window, or the previous watermark window when the watermark jumps
    // forward over whole windows) through the current watermark window. A
    // late event changes state from its own timestamp up to the next event,
    // which may span many windows.
    const earliest = prevWatermark === null ? event.ts : Math.min(event.ts, prevWatermark);
    const fromW = windowStart(earliest);
    const toW = windowStart(this.watermark);
    for (let w = fromW; w <= toW; w += WINDOW_SECONDS) {
      this.publish(event.device, w);
    }
    return { inserted: true, late };
  }

  publish(device, wStart) {
    const key = `${device}|${wStart}`;
    const prev = this.published.get(key);
    const agg = aggregateWindow(this.timelines.get(device), wStart);
    if (
      prev &&
      prev.uptime === agg.uptime &&
      prev.downtime === agg.downtime &&
      prev.unknown === agg.unknown
    ) {
      return;
    }
    const version = prev ? prev.version + 1 : 1;
    if (prev) {
      this.corrections.push({
        type: 'retract',
        device,
        windowStart: wStart,
        version: prev.version,
        uptime: prev.uptime,
        downtime: prev.downtime,
        unknown: prev.unknown,
      });
    }
    const record = { device, version, ...agg };
    this.published.set(key, record);
    this.corrections.push({ type: 'publish', ...record });
  }

  // Current (latest-version) aggregates for every window intersecting [from, to).
  query(device, from, to) {
    const timeline = this.timelines.get(device) ?? null;
    const rows = [];
    for (let w = windowStart(from); w < to; w += WINDOW_SECONDS) {
      const agg = aggregateWindow(timeline, w);
      const published = this.published.get(`${device}|${w}`);
      rows.push({ device, version: published ? published.version : 0, ...agg });
    }
    return rows;
  }
}

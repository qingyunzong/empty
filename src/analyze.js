// Causal analysis of device up/down histories.
//
// Events are partially ordered by their vector clocks. Every topological
// order (linearization) of a device's events is a valid causal execution.
// If all linearizations agree on the total downtime the result is "ok";
// otherwise the device is "ambiguous" and we report the min/max downtime
// observed across all linearizations. Ambiguity is a first-class result,
// never an error.

import { compareClocks } from './clock.js';

const MAX_LINEARIZATIONS = 200000;

// predecessors[j] = set of indices that must come before j.
export function buildPredecessors(events) {
  const n = events.length;
  const predecessors = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i !== j && compareClocks(events[i].clock, events[j].clock) === -1) {
        predecessors[j].add(i);
      }
    }
  }
  return predecessors;
}

// Enumerate all topological orders of the events under the causal poset.
// Returns { orders, truncated }. Orders are produced in a deterministic
// sequence (candidates sorted by ts, then id).
export function enumerateTopoOrders(events, cap = MAX_LINEARIZATIONS) {
  const n = events.length;
  const predecessors = buildPredecessors(events);
  const indegree = predecessors.map((set) => set.size);
  const candidates = [...Array(n).keys()].sort((a, b) => {
    if (events[a].ts !== events[b].ts) return events[a].ts - events[b].ts;
    return events[a].id < events[b].id ? -1 : 1;
  });
  const orders = [];
  const chosen = [];
  const used = new Array(n).fill(false);
  let truncated = false;

  function backtrack() {
    if (orders.length >= cap) {
      truncated = true;
      return;
    }
    if (chosen.length === n) {
      orders.push(chosen.map((i) => events[i]));
      return;
    }
    for (const i of candidates) {
      if (used[i] || indegree[i] !== 0) continue;
      used[i] = true;
      chosen.push(i);
      for (let j = 0; j < n; j += 1) {
        if (predecessors[j].has(i)) indegree[j] -= 1;
      }
      backtrack();
      for (let j = 0; j < n; j += 1) {
        if (predecessors[j].has(i)) indegree[j] += 1;
      }
      chosen.pop();
      used[i] = false;
      if (truncated) return;
    }
  }

  backtrack();
  return { orders, truncated };
}

// Walk one linearization and pair down/up toggles into raw intervals.
// A "down" opens an interval; the next "up" closes it. Redundant toggles
// (down while down, up while up) are ignored. An unclosed interval is open:
// its end is the watermark when the watermark has been reached (>= start),
// otherwise null (end unknown before the watermark).
export function rawIntervals(orderedEvents, watermark = null) {
  const intervals = [];
  let openStart = null;
  for (const event of orderedEvents) {
    if (event.state === 'down') {
      if (openStart === null) openStart = event.ts;
    } else if (openStart !== null) {
      intervals.push({ start: openStart, end: event.ts });
      openStart = null;
    }
  }
  if (openStart !== null) {
    const end = watermark !== null && watermark >= openStart ? watermark : null;
    intervals.push({ start: openStart, end });
  }
  return intervals;
}

// Union of possibly overlapping intervals. A null end acts as +Infinity.
export function unionIntervals(intervals) {
  const sorted = intervals
    .slice()
    .sort((a, b) => a.start - b.start || (a.end ?? Infinity) - (b.end ?? Infinity));
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= (last.end ?? Infinity)) {
      if ((interval.end ?? Infinity) > (last.end ?? Infinity)) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

// Total downtime of a union of intervals; null if any interval is open.
export function totalDuration(intervals) {
  let total = 0;
  for (const interval of intervals) {
    if (interval.end === null) return null;
    total += interval.end - interval.start;
  }
  return total;
}

function round6(value) {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

function observationWindow(events, watermark) {
  if (watermark === null || events.length === 0) return null;
  const start = Math.min(...events.map((event) => event.ts));
  if (watermark <= start) return null;
  return { start, end: watermark };
}

function availabilityFor(downtime, window) {
  if (downtime === null || window === null) return null;
  return round6(1 - downtime / (window.end - window.start));
}

// Analyze one device's events. opts.watermark: observation horizon or null.
export function analyzeDevice(events, { watermark = null } = {}) {
  const { orders, truncated } = enumerateTopoOrders(events);
  const evaluated = orders.map((ordered) => {
    const intervals = unionIntervals(rawIntervals(ordered, watermark));
    return { intervals, downtime: totalDuration(intervals) };
  });
  const window = observationWindow(events, watermark);
  const distinctDowntimes = new Set(evaluated.map((r) => String(r.downtime)));

  if (distinctDowntimes.size === 1 && !truncated) {
    const result = evaluated[0];
    return {
      status: 'ok',
      intervals: result.intervals,
      downtime: result.downtime,
      availability: availabilityFor(result.downtime, window),
      linearizations: orders.length,
    };
  }

  const downtimes = evaluated.map((r) => r.downtime);
  const numeric = downtimes.filter((d) => d !== null);
  const minDowntime = numeric.length > 0 ? Math.min(...numeric) : null;
  const maxDowntime = numeric.length > 0 ? Math.max(...numeric) : null;
  return {
    status: 'ambiguous',
    intervals: evaluated[0].intervals,
    downtime: null,
    minDowntime,
    maxDowntime,
    nullDowntimePossible: downtimes.some((d) => d === null),
    availability: null,
    minAvailability: availabilityFor(maxDowntime, window),
    maxAvailability: availabilityFor(minDowntime, window),
    linearizations: orders.length,
    truncated,
  };
}

// Analyze all devices found in a flat event list.
export function analyzeEvents(events, { watermark = null } = {}) {
  const byDevice = new Map();
  for (const event of events) {
    if (!byDevice.has(event.device)) byDevice.set(event.device, []);
    byDevice.get(event.device).push(event);
  }
  const devices = {};
  for (const device of [...byDevice.keys()].sort()) {
    devices[device] = analyzeDevice(byDevice.get(device), { watermark });
  }
  return { watermark, devices };
}

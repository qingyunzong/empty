import { canonicalOrder, enumerateOrders } from './topo.js';

const DEFAULT_ENUMERATION_CAP = 100000;

// Walk one linearization and derive raw downtime intervals for a device.
// A "down" event opens an interval (or closes immediately at its own `end`
// when provided). The next "up" event closes a pending interval. An interval
// still open at the end of the log closes at the watermark when the watermark
// has passed its start; otherwise its end stays null (not yet known).
export function computeIntervals(orderedEvents, watermark = null) {
  const intervals = [];
  let state = 'up';
  let openStart = null;
  for (const event of orderedEvents) {
    if (event.state === 'down') {
      if (state !== 'up') continue; // redundant down, already down
      if (event.end !== undefined && event.end !== null) {
        intervals.push({ start: event.ts, end: event.end, open: false });
      } else {
        state = 'down';
        openStart = event.ts;
      }
    } else {
      if (state !== 'down') continue; // redundant up, already up
      intervals.push({ start: openStart, end: event.ts, open: false });
      state = 'up';
      openStart = null;
    }
  }
  if (state === 'down') {
    if (watermark !== null && watermark > openStart) {
      intervals.push({ start: openStart, end: watermark, open: true });
    } else {
      intervals.push({ start: openStart, end: null, open: true });
    }
  }
  return intervals;
}

// Union of the closed intervals; open/null-ended intervals are reported
// separately because their duration is not known yet.
export function mergeIntervals(intervals) {
  const closed = intervals
    .filter((i) => i.end !== null)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of closed) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      last.open = last.open || interval.open;
    } else {
      merged.push({ ...interval });
    }
  }
  const unresolved = intervals.filter((i) => i.end === null);
  return { merged, unresolved };
}

export function totalDowntime(intervals) {
  const { merged, unresolved } = mergeIntervals(intervals);
  if (unresolved.length > 0) return null;
  return merged.reduce((sum, i) => sum + (i.end - i.start), 0);
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function computeWindow(events, watermark) {
  let start = Infinity;
  let end = -Infinity;
  for (const event of events) {
    start = Math.min(start, event.ts);
    end = Math.max(end, event.ts);
    if (event.end !== undefined && event.end !== null) end = Math.max(end, event.end);
  }
  if (watermark !== null) end = Math.max(end, watermark);
  return { start, end };
}

function summarizeIntervals(intervals, window) {
  const { merged, unresolved } = mergeIntervals(intervals);
  const downtimeMs = unresolved.length > 0
    ? null
    : merged.reduce((sum, i) => sum + (i.end - i.start), 0);
  const windowMs = window.end - window.start;
  const availability = downtimeMs === null || !(windowMs > 0)
    ? null
    : round6(Math.min(1, Math.max(0, 1 - downtimeMs / windowMs)));
  return {
    intervals: [...merged, ...unresolved].sort((a, b) => a.start - b.start),
    downtimeMs,
    availability,
  };
}

// Compute the downtime summary for one device across every linearization of
// its causal poset. If different linearizations disagree, the result is
// marked ambiguous and the min/max downtime across all topological orders is
// reported. Undecided (open) intervals are never treated as errors.
export function summarizeDevice(device, events, { watermark = null, enumerationCap = DEFAULT_ENUMERATION_CAP } = {}) {
  const window = computeWindow(events, watermark);
  const canonical = canonicalOrder(events).map((i) => events[i]);
  const canonicalSummary = summarizeIntervals(computeIntervals(canonical, watermark), window);

  const { orders, truncated } = enumerateOrders(events, enumerationCap);
  const distinctResults = new Set();
  let minDowntime = null;
  let maxDowntime = null;
  let sawNullDowntime = false;
  for (const order of orders) {
    const intervals = computeIntervals(order.map((i) => events[i]), watermark);
    distinctResults.add(JSON.stringify(mergeIntervals(intervals)));
    const total = totalDowntime(intervals);
    if (total === null) {
      sawNullDowntime = true;
    } else {
      minDowntime = minDowntime === null ? total : Math.min(minDowntime, total);
      maxDowntime = maxDowntime === null ? total : Math.max(maxDowntime, total);
    }
  }

  const ambiguous = distinctResults.size > 1;
  const result = {
    device,
    status: ambiguous ? 'ambiguous' : 'determined',
    eventCount: events.length,
    linearizations: orders.length,
    window,
    intervals: canonicalSummary.intervals,
    downtimeMs: canonicalSummary.downtimeMs,
    availability: canonicalSummary.availability,
  };
  if (ambiguous) {
    result.minDowntimeMs = minDowntime;
    result.maxDowntimeMs = maxDowntime;
    if (sawNullDowntime) result.unboundedLinearizations = true;
  }
  if (truncated) result.enumerationTruncated = true;
  return result;
}

export function summarizeAll(events, options = {}) {
  const byDevice = new Map();
  for (const event of events) {
    if (!byDevice.has(event.device)) byDevice.set(event.device, []);
    byDevice.get(event.device).push(event);
  }
  const devices = {};
  for (const [device, list] of [...byDevice.entries()].sort()) {
    devices[device] = summarizeDevice(device, list, options);
  }
  return devices;
}

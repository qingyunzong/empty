'use strict';

// ---- time helpers: all times are integer minutes since unix epoch (UTC) ----

const MIN_MS = 60000;
const DAY_MIN = 1440;

function parseTime(value) {
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid time: ${value}`);
  return Math.round(ms / MIN_MS);
}

function toISO(minutes) {
  return new Date(minutes * MIN_MS).toISOString();
}

function parseHM(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function dayOf(minutes) {
  return Math.floor(minutes / DAY_MIN);
}

function dateOfDay(dayNum) {
  return new Date(dayNum * DAY_MIN * MIN_MS).toISOString().slice(0, 10);
}

function isWorkday(mold, dayNum) {
  const cal = mold.calendar || {};
  if (Array.isArray(cal.workdays)) return cal.workdays.includes(dateOfDay(dayNum));
  if (Array.isArray(cal.weekdays)) {
    return cal.weekdays.includes(new Date(dayNum * DAY_MIN * MIN_MS).getUTCDay());
  }
  return true;
}

// ---- interval helpers ----

// subtract busy intervals [[s,e],...] from intervals, returning free parts
function subtractBusy(intervals, busy) {
  let result = intervals.filter(([s, e]) => e > s);
  for (const [bs, be] of busy) {
    const next = [];
    for (const [s, e] of result) {
      if (be <= s || bs >= e) { next.push([s, e]); continue; }
      if (bs > s) next.push([s, bs]);
      if (be < e) next.push([be, e]);
    }
    result = next;
  }
  return result;
}

function overlaps(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

// ---- calendar windows ----

const MAX_DAYS = 3660; // safety horizon for window generation

function* productionWindows(mold, fromMin) {
  const cal = mold.calendar || {};
  const start = parseHM(cal.start || '00:00');
  const end = parseHM(cal.end || '24:00');
  const firstDay = dayOf(fromMin);
  for (let day = firstDay; day <= firstDay + MAX_DAYS; day++) {
    if (!isWorkday(mold, day)) continue;
    const s = day * DAY_MIN + start;
    const e = day * DAY_MIN + end;
    if (e > fromMin) yield [s, e];
  }
}

function* shiftWindows(mold, fromMin) {
  const cal = mold.calendar || {};
  const shifts = cal.shifts || [[cal.start || '00:00', cal.end || '24:00']];
  const firstDay = dayOf(fromMin);
  for (let day = firstDay; day <= firstDay + MAX_DAYS; day++) {
    if (!isWorkday(mold, day)) continue;
    for (const [a, b] of shifts) {
      const s = day * DAY_MIN + parseHM(a);
      const e = day * DAY_MIN + parseHM(b);
      if (e > fromMin) yield [s, e];
    }
  }
}

function parsedResets(mold) {
  return (mold.resetIntervals || [])
    .map(([a, b]) => [parseTime(a), parseTime(b)])
    .sort((x, y) => x[0] - y[0]);
}

// ---- placement primitives ----

// Place `minutes` of production at/after pointer, inside calendar windows,
// skipping forced reset intervals. Production may pause across gaps.
function placeOrder(mold, pointer, minutes, resets) {
  let remaining = minutes;
  let start = null;
  let t = pointer;
  const segments = [];
  for (const [ws, we] of productionWindows(mold, pointer)) {
    const free = subtractBusy([[Math.max(ws, pointer), we]], resets);
    for (const [fs, fe] of free) {
      if (remaining <= 0) break;
      if (fe <= t) continue;
      const s = Math.max(fs, t);
      const take = Math.min(remaining, fe - s);
      if (start === null) start = s;
      segments.push([s, s + take]);
      remaining -= take;
      t = s + take;
    }
    if (remaining <= 0) break;
  }
  if (remaining > 0) {
    throw new Error(`calendar exhausted: cannot place ${minutes} minutes for mold ${mold.id}`);
  }
  return { start, end: t, segments };
}

// Earliest maintenance slot at/after pointer: must fit inside one shift
// window, must not overlap forced resets or other maintenance intervals.
function placeMaintenance(mold, pointer, existingMaintenance, resets) {
  const duration = mold.maintenanceMinutes;
  const busy = resets.concat(existingMaintenance);
  for (const [ws, we] of shiftWindows(mold, pointer)) {
    const free = subtractBusy([[Math.max(ws, pointer), we]], busy);
    for (const [fs, fe] of free) {
      if (fe - fs >= duration) return [fs, fs + duration];
    }
  }
  throw new Error(`no maintenance slot available for mold ${mold.id}`);
}

function sumSegments(segments, pred) {
  let total = 0;
  for (const [s, e] of segments) if (pred(s, e)) total += e - s;
  return total;
}

// Simulate placing a sequence of orders back-to-back from `startMin` with
// life counter starting at `used0`. Returns placements and end time, or
// null when the cycle life would be exceeded (maintenance needed first).
function simulateSegment(mold, orders, startMin, used0, resets) {
  let pointer = startMin;
  let used = used0;
  const placements = [];
  for (const order of orders) {
    let p = pointer;
    if (order.notBefore != null) p = Math.max(p, parseTime(order.notBefore));

    // forced resets passed while waiting reset the life counter
    for (const [rs, re] of resets) {
      if (re <= p && re > pointer) used = 0;
    }

    const trial = placeOrder(mold, p, order.minutes, resets);
    const mid = resets.filter(([rs, re]) => rs >= trial.start && re <= trial.end);
    let preResetMinutes = order.minutes;
    if (mid.length > 0) {
      const firstRs = Math.min(...mid.map((r) => r[0]));
      preResetMinutes = sumSegments(trial.segments, (s, e) => e <= firstRs);
    }
    if (used + preResetMinutes > mold.cycleMinutes) return null;

    if (mid.length > 0) {
      const lastRe = Math.max(...mid.map((r) => r[1]));
      used = sumSegments(trial.segments, (s) => s >= lastRe);
    } else {
      used += order.minutes;
    }
    placements.push({ order, start: trial.start, end: trial.end, segments: trial.segments });
    pointer = trial.end;
  }
  return { end: pointer, used, placements };
}

// ---- queue rescheduling ----
// Partitions the queue into life-cycle segments separated by maintenance.
// Dynamic programming over segment boundaries optimizes lexicographically:
//   1. fewest maintenances, 2. earliest final completion.
// Each maintenance is placed at the earliest feasible shift slot at/after
// the segment end. Forced reset intervals are busy and reset the counter.
function reschedule(mold, orders) {
  const resets = parsedResets(mold);
  const n = orders.length;
  const startMin = mold.startTime != null ? parseTime(mold.startTime) : 0;
  const used0 = mold.usedMinutes || 0;

  // best[i]: orders[0..i) placed and maintenance done, counter = 0
  const best = new Array(n + 1).fill(null);
  best[0] = { count: 0, time: startMin, from: -1, segEnd: startMin, maint: null };
  for (let i = 0; i <= n; i++) {
    if (!best[i]) continue;
    const segUsed = i === 0 ? used0 : 0;
    for (let j = i + 1; j <= n; j++) {
      const seg = simulateSegment(mold, orders.slice(i, j), best[i].time, segUsed, resets);
      if (!seg) break; // infeasibility is prefix-monotone
      let cand;
      if (j < n) {
        const [ms, me] = placeMaintenance(mold, seg.end, [], resets);
        cand = { count: best[i].count + 1, time: me, from: i, segEnd: seg.end, maint: [ms, me] };
      } else {
        cand = { count: best[i].count, time: seg.end, from: i, segEnd: seg.end, maint: null };
      }
      if (!best[j] || cand.count < best[j].count ||
          (cand.count === best[j].count && cand.time < best[j].time)) {
        best[j] = cand;
      }
    }
  }
  if (!best[n]) throw new Error(`cannot schedule mold ${mold.id}: no feasible plan`);

  // reconstruct segments from the DP chain
  const bounds = [];
  for (let cur = n; cur > 0; cur = best[cur].from) bounds.push(cur);
  bounds.push(0);
  bounds.reverse();

  const items = [];
  const maintenances = [];
  let used = used0;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const i = bounds[k];
    const j = bounds[k + 1];
    const segUsed = i === 0 ? used0 : 0;
    const segStart = best[i].time;
    const seg = simulateSegment(mold, orders.slice(i, j), segStart, segUsed, resets);
    for (const pl of seg.placements) {
      items.push({ type: 'order', orderId: pl.order.id, start: pl.start, end: pl.end, segments: pl.segments });
    }
    used = seg.used;
    if (best[j].maint) {
      maintenances.push(best[j].maint);
      items.push({ type: 'maintenance', start: best[j].maint[0], end: best[j].maint[1] });
      used = 0;
    }
  }
  items.sort((a, b) => a.start - b.start);

  return { items, maintenances, end: best[n].time, used };
}

module.exports = {
  parseTime,
  toISO,
  subtractBusy,
  overlaps,
  productionWindows,
  shiftWindows,
  parsedResets,
  placeOrder,
  placeMaintenance,
  simulateSegment,
  reschedule,
};

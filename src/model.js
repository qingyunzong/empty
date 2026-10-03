import { runProgram, formatInstant } from './bytecode.js';

export const HORIZON_START = Date.UTC(2026, 0, 5) / 60000; // Monday 2026-01-05T00:00Z
export const HORIZON_WEEKS = 12;

export class Model {
  constructor() {
    this.lines = [];
    this.lineId = new Map();
    this.calendars = [];
    this.maintenance = [];
    this.jobs = new Map();
    this.constraints = [];
  }
  addLine(name) {
    if (this.lineId.has(name)) throw new Error(`duplicate line '${name}'`);
    this.lineId.set(name, this.lines.length);
    this.lines.push(name);
  }
  addJob(job) {
    if (this.jobs.has(job.name)) throw new Error(`duplicate job '${job.name}'`);
    this.jobs.set(job.name, job);
  }
}

export function mergeIntervals(ivs) {
  const sorted = ivs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length && s <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

export function subtract(ivs, blocks) {
  let cur = ivs.map((i) => [i[0], i[1]]);
  for (const [bs, be] of blocks) {
    const next = [];
    for (const [s, e] of cur) {
      if (be <= s || bs >= e) { next.push([s, e]); continue; }
      if (bs > s) next.push([s, bs]);
      if (be < e) next.push([be, e]);
    }
    cur = next;
  }
  return cur;
}

export function buildWindows(model) {
  const ivs = [];
  for (let week = 0; week < HORIZON_WEEKS; week++) {
    for (let day = 0; day < 7; day++) {
      const weekday = day + 1;
      const dayStart = HORIZON_START + (week * 7 + day) * 1440;
      for (const cal of model.calendars) {
        for (const sh of cal.shifts) {
          if (weekday >= sh.days[0] && weekday <= sh.days[1]) {
            ivs.push([dayStart + sh.from, dayStart + sh.to]);
          }
        }
      }
    }
  }
  return mergeIntervals(ivs);
}

export function maintenanceOf(model, lineId) {
  return model.maintenance
    .filter((m) => m.lineId === lineId)
    .map((m) => [m.start, m.start + m.dur]);
}

export function maxConcurrency(intervals) {
  const events = [];
  for (const iv of intervals) {
    events.push([iv.start, 1], [iv.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, best = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > best) best = cur;
  }
  return best;
}

function topoOrder(jobs) {
  const indeg = new Map();
  for (const j of jobs.values()) indeg.set(j.name, 0);
  for (const j of jobs.values()) {
    for (const d of j.after) {
      if (!jobs.has(d)) return null;
      indeg.set(j.name, indeg.get(j.name) + 1);
    }
  }
  const queue = [...jobs.values()].filter((j) => indeg.get(j.name) === 0).map((j) => j.name);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const j of jobs.values()) {
      if (j.after.includes(n)) {
        indeg.set(j.name, indeg.get(j.name) - 1);
        if (indeg.get(j.name) === 0) queue.push(j.name);
      }
    }
  }
  return order.length === jobs.size ? order : null;
}

// Incremental constraint validation: only programs whose linesUsed contains
// the touched line are re-evaluated for a candidate placement.
function constraintsOk(model, byLine, lineId, candidate) {
  const cache = new Map();
  const ctx = {
    overlap(id) {
      if (!cache.has(`o${id}`)) {
        const ivs = (byLine.get(id) || []).slice();
        if (id === lineId && candidate) ivs.push(candidate);
        cache.set(`o${id}`, maxConcurrency(ivs));
      }
      return cache.get(`o${id}`);
    },
    total(id) {
      if (!cache.has(`t${id}`)) {
        let sum = 0;
        for (const iv of byLine.get(id) || []) sum += iv.end - iv.start;
        if (id === lineId && candidate) sum += candidate.end - candidate.start;
        cache.set(`t${id}`, sum);
      }
      return cache.get(`t${id}`);
    },
  };
  for (const c of model.constraints) {
    if (!c.prog.linesUsed.has(lineId)) continue;
    const v = runProgram(c.prog, ctx);
    if (v.t !== 'bool') throw new Error('constraint program did not yield bool');
    if (!v.v) return false;
  }
  return true;
}

function findSlot(freeIvs, placed, earliest, dur, ok) {
  for (const [fs, fe] of freeIvs) {
    let s = Math.max(fs, earliest);
    let guard = 0;
    while (s + dur <= fe && guard++ < 100000) {
      if (ok(s)) return s;
      let minEnd = Infinity;
      for (const iv of placed) {
        if (iv.start < s + dur && s < iv.end) minEnd = Math.min(minEnd, iv.end);
      }
      s = minEnd === Infinity ? fe : Math.max(s + 1, minEnd);
    }
  }
  return null;
}

// Greedy list scheduler: priority desc, then name asc; dependencies first.
// Returns Map name -> {line, start, end} or null when infeasible.
export function schedule(model) {
  const windows = buildWindows(model);
  const free = new Map();
  for (const [name, id] of model.lineId) {
    free.set(id, subtract(windows, maintenanceOf(model, id)));
  }
  if (topoOrder(model.jobs) === null) return null;
  const sorted = [...model.jobs.values()].sort(
    (a, b) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const placed = new Map();
  const byLine = new Map();
  const place = (job) => {
    if (placed.has(job.name)) return true;
    let earliest = 0;
    for (const dep of job.after) {
      const dj = model.jobs.get(dep);
      if (!dj || !place(dj)) return false;
      earliest = Math.max(earliest, placed.get(dep).end);
    }
    const lineId = model.lineId.get(job.line);
    if (lineId === undefined) return false;
    const ivals = byLine.get(lineId) || [];
    const ok = (s) => constraintsOk(model, byLine, lineId, { start: s, end: s + job.duration });
    const start = findSlot(free.get(lineId), ivals, earliest, job.duration, ok);
    if (start === null) return false;
    placed.set(job.name, { line: job.line, start, end: start + job.duration });
    ivals.push({ start, end: start + job.duration });
    ivals.sort((a, b) => a.start - b.start);
    byLine.set(lineId, ivals);
    return true;
  };
  for (const job of sorted) {
    if (!place(job)) return null;
  }
  return placed;
}

export function scheduleToJSON(model, placed) {
  const jobs = [...placed.entries()]
    .map(([name, p]) => ({
      name,
      line: p.line,
      start: formatInstant(p.start),
      end: formatInstant(p.end),
    }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.name < b.name ? -1 : 1));
  return { feasible: true, jobs };
}

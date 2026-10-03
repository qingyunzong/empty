import { indexInstance } from './instance.js';

// Earliest feasible start for a job on a machine, given already placed jobs.
// placed intervals on the machine never overlap; memory usage is piecewise
// constant over event points, so checking event starts suffices.
function earliestStart(t0, job, machineIntervals, running, memoryLimit) {
  let t = t0;
  for (;;) {
    const clash = machineIntervals.find(([s, e]) => s < t + job.duration && t < e);
    if (clash) {
      t = clash[1];
      continue;
    }
    const points = new Set([t]);
    for (const r of running) {
      if (r.start > t && r.start < t + job.duration) points.add(r.start);
    }
    let badAt = -1;
    for (const pt of points) {
      let used = 0;
      for (const r of running) {
        if (r.start <= pt && pt < r.end) used += r.mem;
      }
      if (used + job.memory > memoryLimit) {
        badAt = pt;
        break;
      }
    }
    if (badAt === -1) return t;
    let next = Infinity;
    for (const r of running) {
      if (r.start <= badAt && badAt < r.end && r.end > t) next = Math.min(next, r.end);
    }
    t = next === Infinity ? badAt + 1 : next;
  }
}

// A plan builder shared by solver and brute force. Decisions are applied in
// order (which induces the topological order of the schedule).
// decisions: [{ step, param, machine }]
// Returns { jobs, makespan, peak } with jobs sorted by step id.
export function buildSchedule(inst, decisions, idx = indexInstance(inst)) {
  const placed = new Map();
  const machineIntervals = Array.from({ length: inst.machines }, () => []);
  const running = [];
  for (const d of decisions) {
    const job = idx.byId.get(d.step);
    let t = 0;
    for (const p of idx.preds.get(d.step)) t = Math.max(t, placed.get(p).end);
  t = earliestStart(t, job, machineIntervals[d.machine], running, inst.memoryLimit);
  const rec = { step: d.step, param: d.param, machine: d.machine, start: t, end: t + job.duration };
  placed.set(d.step, rec);
  machineIntervals[d.machine].push([t, rec.end]);
  running.push({ step: d.step, start: t, end: rec.end, mem: job.memory });
  }
  const jobs = [...placed.values()].sort((a, b) => (a.step < b.step ? -1 : 1));
  let makespan = 0;
  let peak = 0;
  const events = new Set();
  for (const r of running) {
    events.add(r.start);
    makespan = Math.max(makespan, r.end);
  }
  for (const pt of events) {
    let used = 0;
    for (const r of running) if (r.start <= pt && pt < r.end) used += r.mem;
    peak = Math.max(peak, used);
  }
  return { jobs, makespan, peak };
}

// Incremental placer used by the solver: places one job given current state.
export function placeOne(inst, idx, placed, machineIntervals, running, step, param, machine) {
  const job = idx.byId.get(step);
  let t = 0;
  for (const p of idx.preds.get(step)) t = Math.max(t, placed.get(p).end);
  t = earliestStart(t, job, machineIntervals[machine], running, inst.memoryLimit);
  const rec = { step, param, machine, start: t, end: t + job.duration };
  placed.set(step, rec);
  machineIntervals[machine].push([t, rec.end]);
  running.push({ step, start: t, end: rec.end, mem: job.memory });
  return rec;
}

export function unplaceOne(placed, machineIntervals, running, rec) {
  placed.delete(rec.step);
  const list = machineIntervals[rec.machine];
  const at = list.findIndex(([s, e]) => s === rec.start && e === rec.end);
  list.splice(at, 1);
  const ri = running.findIndex((r) => r.step === rec.step);
  running.splice(ri, 1);
}

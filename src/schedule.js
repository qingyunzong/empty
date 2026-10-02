import { setupMinutes } from './model.js';
import { InfeasibleError } from './errors.js';

const EPS = 1e-9;
const round = (x) => Math.round(x * 1e9) / 1e9;
export const EXACT_LIMIT = 9; // n! exhaustive search up to 9 orders; deterministic greedy beyond

// Decode a permutation into an executable sequence.
// Machine / mold / operator are mutually exclusive resources: a job occupies
// all three for [start, end]; overlaps are resolved by ordering, never silently.
export function decode(ds, seq) {
  const machineAvail = new Map(), machineLastMold = new Map();
  const moldAvail = new Map(), opAvail = new Map();
  const jobs = [];
  for (const id of seq) {
    const o = ds.orders.get(id);
    const mold = ds.molds.get(o.mold);
    const machine = mold.machine;
    const rate = ds.machines.get(machine).rate;
    const setup = setupMinutes(ds, machineLastMold.get(machine) ?? null, o.mold);
    const duration = o.qty / rate;
    const start = round(Math.max(machineAvail.get(machine) ?? 0, moldAvail.get(o.mold) ?? 0, opAvail.get(o.operator) ?? 0));
    const end = round(start + setup + duration);
    machineAvail.set(machine, end);
    machineLastMold.set(machine, o.mold);
    moldAvail.set(o.mold, end);
    opAvail.set(o.operator, end);
    jobs.push({ id, machine, mold: o.mold, operator: o.operator, setup: round(setup), duration: round(duration), start, end });
  }
  return jobs;
}

export function score(ds, seq) {
  const jobs = decode(ds, seq);
  let makespan = 0, totalSetup = 0;
  for (const j of jobs) { makespan = Math.max(makespan, j.end); totalSetup += j.setup; }
  return { jobs, makespan: round(makespan), totalSetup: round(totalSetup) };
}

// Deterministic total order: earliest makespan, then fewer changeovers,
// then lexicographic order-id sequence.
export function compareScore(a, b) {
  if (Math.abs(a.makespan - b.makespan) > EPS) return a.makespan - b.makespan;
  if (Math.abs(a.totalSetup - b.totalSetup) > EPS) return a.totalSetup - b.totalSetup;
  const n = Math.min(a.seq.length, b.seq.length);
  for (let i = 0; i < n; i++) {
    if (a.seq[i] !== b.seq[i]) return a.seq[i] < b.seq[i] ? -1 : 1;
  }
  return a.seq.length - b.seq.length;
}

function* permutations(items) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

export function optimize(ds, ids = [...ds.orders.keys()]) {
  const seq = [...ids].sort();
  if (seq.length === 0) return { seq, jobs: [], makespan: 0, totalSetup: 0 };
  if (seq.length <= EXACT_LIMIT) {
    let best = null;
    for (const p of permutations(seq)) {
      const s = score(ds, p);
      const cand = { seq: p, ...s };
      if (!best || compareScore(cand, best) < 0) best = cand;
    }
    return best;
  }
  // Deterministic best-insertion heuristic for large sets.
  let cur = [];
  for (const id of seq) {
    let best = null;
    for (let i = 0; i <= cur.length; i++) {
      const p = cur.slice(0, i).concat(id, cur.slice(i));
      const s = score(ds, p);
      const cand = { seq: p, ...s };
      if (!best || compareScore(cand, best) < 0) best = cand;
    }
    cur = best.seq;
  }
  return { seq: cur, ...score(ds, cur) };
}

export function lateJobs(ds, result) {
  return result.jobs.filter((j) => j.end > ds.orders.get(j.id).due + EPS);
}

export function isInfeasible(ds, ids) {
  return lateJobs(ds, optimize(ds, ids)).length > 0;
}

// Minimal (irreducible) conflict set: removing any remaining member makes it feasible.
export function minimalConflict(ds, ids) {
  let set = [...ids];
  for (const id of [...set]) {
    const trial = set.filter((x) => x !== id);
    if (trial.length > 0 && isInfeasible(ds, trial)) set = trial;
  }
  return set.sort();
}

// Optimize and enforce due dates as hard constraints.
export function plan(ds) {
  const ids = [...ds.orders.keys()];
  const result = optimize(ds, ids);
  if (lateJobs(ds, result).length > 0) throw new InfeasibleError(minimalConflict(ds, ids));
  return result;
}

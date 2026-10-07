'use strict';

const crypto = require('crypto');
const { SchedError } = require('./errors');

const MAX_JOBS = 20;

// Canonical tie-break total order over complete plans:
//   1. Lmax (max lateness) ascending
//   2. device assignment tuple (jobs in canonical id order, device index) lexicographic
//   3. machine-0 (lmax, makespan), then machine-1 (lmax, makespan)
//   4. machine-0 job sequence, then machine-1 job sequence, lexicographic by canonical index
// The subset DP below is exact for 1-3. For 4, the lexicographically smallest
// sequence attaining the chosen per-machine (lmax, makespan) point is extracted
// afterwards by a memoized feasibility DP (Pareto pruning alone cannot keep
// lexic-min sequences, because release-date clamping can make a dominated
// prefix lead to the same final (t, l) with a smaller sequence).

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function inputHashOf(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function normalizeDevices(devices) {
  const list = devices && devices.length ? devices : [{ id: 'M1' }, { id: 'M2' }];
  const norm = list.map((d) => ({
    id: String(d.id),
    capacity: d.capacity === undefined || d.capacity === null ? null : d.capacity,
  }));
  norm.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return norm;
}

function normalizeJobs(jobs) {
  return jobs
    .map((j) => ({
      id: String(j.id),
      release: j.release,
      due: j.due,
      duration: j.duration,
      devices: j.devices == null ? null : [...new Set(j.devices.map(String))].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function prepareInput(input) {
  const rawJobs = input && Array.isArray(input.jobs) ? input.jobs : [];
  const jobs = normalizeJobs(rawJobs);
  const devices = normalizeDevices(input && input.devices);
  if (jobs.length > MAX_JOBS) {
    throw new SchedError('E_INVALID', `at most ${MAX_JOBS} jobs supported, got ${jobs.length}`);
  }
  if (devices.length !== 2) {
    throw new SchedError('E_INVALID', `exactly two devices are required, got ${devices.length}`);
  }
  const deviceIds = new Set();
  for (const d of devices) {
    if (deviceIds.has(d.id)) throw new SchedError('E_INVALID', `duplicate device id ${d.id}`);
    deviceIds.add(d.id);
    if (d.capacity !== null && !(typeof d.capacity === 'number' && d.capacity > 0)) {
      throw new SchedError('E_INVALID', `device ${d.id}: capacity must be a positive number or null`);
    }
  }
  const seen = new Set();
  for (const j of jobs) {
    if (seen.has(j.id)) throw new SchedError('E_INVALID', `duplicate job id ${j.id}`);
    seen.add(j.id);
    for (const f of ['release', 'due', 'duration']) {
      if (typeof j[f] !== 'number' || !Number.isFinite(j[f])) {
        throw new SchedError('E_INVALID', `job ${j.id}: ${f} must be a finite number`);
      }
    }
    if (!(j.duration > 0)) throw new SchedError('E_INVALID', `job ${j.id}: duration must be positive`);
    if (j.devices !== null) {
      for (const d of j.devices) {
        if (!deviceIds.has(d)) throw new SchedError('E_INVALID', `job ${j.id}: unknown device ${d}`);
      }
    }
  }
  return { jobs, devices };
}

// Keep Pareto-minimal (t=completion time, l=max lateness) entries.
function reduceFrontier(cands) {
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  let bestL = Infinity;
  for (const c of cands) {
    if (c.l >= bestL) continue;
    out.push(c);
    bestL = c.l;
  }
  return out;
}

// Exact Pareto DP over subsets for one machine: frontier[mask] = list of
// non-dominated {t, l} entries, t ascending, l strictly
// descending; the last entry always carries the minimal l for the mask.
function machineFrontiers(jobs, eligible, horizon) {
  const n = jobs.length;
  const size = 1 << n;
  const frontier = new Array(size);
  frontier[0] = [{ t: 0, l: -Infinity }];
  for (let mask = 1; mask < size; mask++) {
    const cands = [];
    for (let j = 0; j < n; j++) {
      const bit = 1 << j;
      if (!(mask & bit) || !eligible[j]) continue;
      const prevMask = mask ^ bit;
      const prev = frontier[prevMask];
      if (!prev) continue;
      const job = jobs[j];
      for (let k = 0; k < prev.length; k++) {
        const e = prev[k];
        const t = Math.max(e.t, job.release) + job.duration;
        if (t > horizon) continue;
        const l = Math.max(e.l, t - job.due);
        cands.push({ t, l });
      }
    }
    frontier[mask] = reduceFrontier(cands);
  }
  return frontier;
}

// Lexicographically smallest job sequence (by canonical job index) for one
// machine that attains lmax <= lStar and makespan <= tStar. Both bounds are
// tight for the chosen frontier point, so this is exactly the set of sequences
// the canonical total order minimizes over. `indices` lists the canonical
// indices of the jobs assigned to the machine, in ascending order.
function extractSequence(jobs, indices, horizon, lStar, tStar) {
  const m = indices.length;
  const memo = new Map(); // mask -> Map<tau, boolean>
  function can(mask, tau) {
    if (mask === 0) return tau <= tStar;
    let byTau = memo.get(mask);
    if (byTau === undefined) {
      byTau = new Map();
      memo.set(mask, byTau);
    } else if (byTau.has(tau)) {
      return byTau.get(tau);
    }
    let ok = false;
    for (let i = 0; i < m && !ok; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      const job = jobs[indices[i]];
      const t = Math.max(tau, job.release) + job.duration;
      if (t > tStar || t > horizon) continue;
      if (t - job.due > lStar) continue;
      ok = can(mask ^ bit, t);
    }
    byTau.set(tau, ok);
    return ok;
  }
  const seq = [];
  let mask = (1 << m) - 1;
  let tau = 0;
  while (mask !== 0) {
    let chosen = -1;
    for (let i = 0; i < m; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      const job = jobs[indices[i]];
      const t = Math.max(tau, job.release) + job.duration;
      if (t > tStar || t > horizon) continue;
      if (t - job.due > lStar) continue;
      if (can(mask ^ bit, t)) {
        chosen = i;
        break;
      }
    }
    if (chosen === -1) {
      throw new SchedError('E_INTERNAL', 'sequence extraction failed for a feasible frontier point');
    }
    seq.push(indices[chosen]);
    const job = jobs[indices[chosen]];
    tau = Math.max(tau, job.release) + job.duration;
    mask ^= 1 << chosen;
  }
  return seq;
}

function cmpAssign(a, b, n) {
  for (let j = 0; j < n; j++) {
    const ba = (a >> j) & 1;
    const bb = (b >> j) & 1;
    if (ba !== bb) return ba - bb;
  }
  return 0;
}

function scheduleOf(jobs, seqIdx) {
  let t = 0;
  const ops = [];
  for (const j of seqIdx) {
    const job = jobs[j];
    const start = Math.max(t, job.release);
    const end = start + job.duration;
    ops.push({ jobId: job.id, start, end });
    t = end;
  }
  return ops;
}

// First unschedulable job in canonical (sorted jobId) order: a job with no
// eligible device, or one that cannot fit any eligible device even alone.
// If infeasibility is only aggregate (combined capacity), the first job in
// canonical order is reported.
function firstUnschedulableJob(jobs, devices) {
  for (const j of jobs) {
    const eligible = devices.filter((d) => j.devices === null || j.devices.includes(d.id));
    if (eligible.length === 0) return j.id;
    const fits = eligible.some(
      (d) => d.capacity === null || j.release + j.duration <= d.capacity
    );
    if (!fits) return j.id;
  }
  return jobs[0].id;
}

function solve(input) {
  const { jobs, devices } = prepareInput(input);
  const n = jobs.length;
  const certificateBase = {
    algorithm: 'exact-subset-dp',
    inputHash: inputHashOf({ jobs, devices }),
  };
  if (n === 0) {
    return {
      objective: 0,
      assignments: [],
      schedule: Object.fromEntries(devices.map((d) => [d.id, []])),
      certificate: { ...certificateBase, objective: 0, tieCount: 1, tieRank: 1 },
    };
  }
  const horizons = devices.map((d) => (d.capacity === null ? Infinity : d.capacity));
  const frontiers = devices.map((d, m) =>
    machineFrontiers(
      jobs,
      jobs.map((j) => j.devices === null || j.devices.includes(d.id)),
      horizons[m]
    )
  );
  const size = 1 << n;
  const full = size - 1;
  // mask = set of jobs assigned to devices[1]; the complement runs on
  // devices[0]. The assignment tuple (one bit per job in canonical order) is
  // thus the per-job device index, and lexicographic-min prefers devices[0].
  let best = null;
  for (let mask = 0; mask < size; mask++) {
    const f0 = frontiers[0][full ^ mask];
    if (!f0) continue;
    const f1 = frontiers[1][mask];
    if (!f1) continue;
    const L = Math.max(f0[f0.length - 1].l, f1[f1.length - 1].l);
    if (best === null || L < best.L || (L === best.L && cmpAssign(mask, best.mask, n) < 0)) {
      best = { L, mask };
    }
  }
  if (best === null) {
    throw new SchedError('E_INFEASIBLE', 'no feasible schedule for the given jobs and device capacities', {
      jobId: firstUnschedulableJob(jobs, devices),
    });
  }
  let tieCount = 0;
  let tieRank = 0;
  for (let mask = 0; mask < size; mask++) {
    const f0 = frontiers[0][full ^ mask];
    if (!f0) continue;
    const f1 = frontiers[1][mask];
    if (!f1) continue;
    if (Math.max(f0[f0.length - 1].l, f1[f1.length - 1].l) === best.L) {
      tieCount++;
      if (cmpAssign(mask, best.mask, n) < 0) tieRank++;
    }
  }
  tieRank += 1; // 1-based rank of the chosen assignment among tied assignments
  const e0 = frontiers[0][full ^ best.mask];
  const e1 = frontiers[1][best.mask];
  const p0 = e0[e0.length - 1];
  const p1 = e1[e1.length - 1];
  const idx0 = [];
  const idx1 = [];
  for (let j = 0; j < n; j++) ((best.mask >> j) & 1 ? idx1 : idx0).push(j);
  const seq0 = extractSequence(jobs, idx0, horizons[0], p0.l, p0.t);
  const seq1 = extractSequence(jobs, idx1, horizons[1], p1.l, p1.t);
  const schedule = {};
  schedule[devices[0].id] = scheduleOf(jobs, seq0);
  schedule[devices[1].id] = scheduleOf(jobs, seq1);
  const assignments = jobs.map((j, idx) => ({
    jobId: j.id,
    deviceId: (best.mask >> idx) & 1 ? devices[1].id : devices[0].id,
  }));
  return {
    objective: best.L,
    assignments,
    schedule,
    certificate: { ...certificateBase, objective: best.L, tieCount, tieRank },
  };
}

module.exports = {
  MAX_JOBS,
  solve,
  prepareInput,
  firstUnschedulableJob,
  stableStringify,
  inputHashOf,
};

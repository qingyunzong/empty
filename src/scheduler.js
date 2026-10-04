import { canonicalize, sha256 } from './util.js';

export const DEFAULT_DEVICES = ['M1', 'M2'];
export const MAX_JOBS = 20;
export const CERT_ENUM_LIMIT = 6;
export const ALGORITHM_ID = 'bnb-lmax-v2';

const ID_RE = /^[A-Za-z0-9_.-]+$/;

export class ScheduleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    Object.assign(this, details);
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeDevices(input) {
  const devices = input === undefined || input === null ? DEFAULT_DEVICES.slice() : input;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new ScheduleError('E_INVALID', 'devices must be a non-empty array');
  }
  for (const d of devices) {
    if (typeof d !== 'string' || !ID_RE.test(d)) {
      throw new ScheduleError('E_INVALID', `invalid device id: ${String(d)}`);
    }
  }
  if (new Set(devices).size !== devices.length) {
    throw new ScheduleError('E_INVALID', 'duplicate device id');
  }
  return devices.slice();
}

export function normalizeJobs(inputJobs, devices) {
  if (!Array.isArray(inputJobs)) {
    throw new ScheduleError('E_INVALID', 'jobs must be an array');
  }
  const jobs = inputJobs.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ScheduleError('E_INVALID', 'each job must be an object');
    }
    const { id, release, due, duration } = raw;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new ScheduleError('E_INVALID', `invalid job id: ${String(id)}`);
    }
    if (!isFiniteNumber(release)) {
      throw new ScheduleError('E_INVALID', `job ${id}: release must be a finite number`);
    }
    if (!isFiniteNumber(due)) {
      throw new ScheduleError('E_INVALID', `job ${id}: due must be a finite number`);
    }
    if (!isFiniteNumber(duration) || duration <= 0) {
      throw new ScheduleError('E_INVALID', `job ${id}: duration must be a positive finite number`);
    }
    let allowed;
    if (raw.devices === undefined || raw.devices === null) {
      allowed = devices.slice();
    } else {
      if (!Array.isArray(raw.devices)) {
        throw new ScheduleError('E_INVALID', `job ${id}: devices must be an array`);
      }
      for (const d of raw.devices) {
        if (!devices.includes(d)) {
          throw new ScheduleError('E_INVALID', `job ${id}: unknown device ${String(d)}`);
        }
      }
      const wanted = new Set(raw.devices);
      allowed = devices.filter((d) => wanted.has(d));
    }
    return { id, release, due, duration, devices: allowed };
  });
  jobs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < jobs.length; i += 1) {
    if (jobs[i].id === jobs[i - 1].id) {
      throw new ScheduleError('E_INVALID', `duplicate job id: ${jobs[i].id}`);
    }
  }
  return jobs;
}

export function checkFeasible(jobs) {
  if (jobs.length > MAX_JOBS) {
    throw new ScheduleError('E_INFEASIBLE', `job count ${jobs.length} exceeds capacity ${MAX_JOBS}`, {
      jobId: jobs[MAX_JOBS].id,
    });
  }
  for (const job of jobs) {
    if (job.devices.length === 0) {
      throw new ScheduleError('E_INFEASIBLE', `job ${job.id} has no eligible device`, { jobId: job.id });
    }
  }
}

function simulate(jobs, devices, seqs) {
  const entries = [];
  let objective = -Infinity;
  for (let di = 0; di < devices.length; di += 1) {
    let t = 0;
    for (const ji of seqs[di]) {
      const job = jobs[ji];
      const start = Math.max(job.release, t);
      const end = start + job.duration;
      t = end;
      const lateness = end - job.due;
      if (lateness > objective) objective = lateness;
      entries.push({ jobId: job.id, deviceId: devices[di], start, end });
    }
  }
  entries.sort((a, b) => {
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    if (a.start !== b.start) return a.start - b.start;
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
  });
  return { objective: entries.length === 0 ? null : objective, entries };
}

function assignmentKey(jobs, devices, deviceOf) {
  return jobs.map((j, i) => `${j.id}=${devices[deviceOf[i]]}`).join(',');
}

function sequenceKey(jobs, seqs) {
  return seqs.map((list) => list.map((i) => jobs[i].id).join(',')).join('|');
}

export function comparePlans(a, b) {
  if (a.objective !== b.objective) return a.objective < b.objective ? -1 : 1;
  if (a.assignmentKey !== b.assignmentKey) return a.assignmentKey < b.assignmentKey ? -1 : 1;
  if (a.sequenceKey !== b.sequenceKey) return a.sequenceKey < b.sequenceKey ? -1 : 1;
  return 0;
}

// Reference enumerator: every permutation x every device-choice vector.
export function enumeratePlans(jobs, devices) {
  const n = jobs.length;
  const allowed = jobs.map((j) => j.devices.map((d) => devices.indexOf(d)));

  const vectors = [];
  const current = new Array(n).fill(0);
  const genVectors = (i) => {
    if (i === n) {
      vectors.push(current.slice());
      return;
    }
    for (const di of allowed[i]) {
      current[i] = di;
      genVectors(i + 1);
    }
  };
  genVectors(0);

  const perms = [];
  const used = new Array(n).fill(false);
  const perm = [];
  const genPerms = () => {
    if (perm.length === n) {
      perms.push(perm.slice());
      return;
    }
    for (let i = 0; i < n; i += 1) {
      if (!used[i]) {
        used[i] = true;
        perm.push(i);
        genPerms();
        used[i] = false;
        perm.pop();
      }
    }
  };
  genPerms();

  const plans = [];
  for (const p of perms) {
    for (const vec of vectors) {
      const seqs = devices.map(() => []);
      for (const ji of p) seqs[vec[ji]].push(ji);
      const { objective, entries } = simulate(jobs, devices, seqs);
      plans.push({
        objective,
        entries,
        deviceOf: vec.slice(),
        seqs: seqs.map((s) => s.slice()),
        assignmentKey: assignmentKey(jobs, devices, vec),
        sequenceKey: sequenceKey(jobs, seqs),
      });
    }
  }
  return plans;
}

export function tieRankAndCount(plans, best) {
  let rank = 0;
  let count = 0;
  for (const p of plans) {
    if (p.objective === best.objective) {
      count += 1;
      if (rank === 0 && p.assignmentKey === best.assignmentKey && p.sequenceKey === best.sequenceKey) {
        rank = count;
      }
    }
  }
  return { tieRank: rank, optimalCount: count };
}

// Branch & bound over (job, device) placements with Pareto-dominance pruning.
// Objective-only; used to compute the optimal Lmax and for bounded feasibility checks.
function makeSearch(jobs, allowed, m) {
  const n = jobs.length;
  const order = jobs.map((_, i) => i);
  order.sort((a, b) => {
    const ja = jobs[a];
    const jb = jobs[b];
    if (ja.due !== jb.due) return ja.due - jb.due;
    if (ja.release !== jb.release) return ja.release - jb.release;
    return ja.id < jb.id ? -1 : 1;
  });
  const fullMask = n === 0 ? 0 : (1 << n) - 1;

  const lowerBound = (mask, t, curMax) => {
    let lb = curMax;
    for (let ji = 0; ji < n; ji += 1) {
      if (mask & (1 << ji)) continue;
      const job = jobs[ji];
      let minT = Infinity;
      for (const di of allowed[ji]) {
        if (t[di] < minT) minT = t[di];
      }
      const est = Math.max(job.release, minT) + job.duration - job.due;
      if (est > lb) lb = est;
    }
    return lb;
  };

  // frontier per mask: list of { t: [...], curMax } mutually non-dominating
  const frontiers = new Map();
  const isDominated = (list, t, curMax) =>
    list.some((s) => s.curMax <= curMax && s.t.every((v, i) => v <= t[i]));
  const insert = (mask, t, curMax) => {
    let list = frontiers.get(mask);
    if (!list) {
      list = [];
      frontiers.set(mask, list);
    }
    if (isDominated(list, t, curMax)) return false;
    const kept = list.filter((s) => !(curMax <= s.curMax && t.every((v, i) => v <= s.t[i])));
    kept.push({ t: t.slice(), curMax });
    frontiers.set(mask, kept);
    return true;
  };

  return { n, order, fullMask, lowerBound, frontiers, insert };
}

function optimizeLmax(jobs, allowed, m) {
  const { n, order, fullMask, lowerBound, insert } = makeSearch(jobs, allowed, m);
  let best = Infinity;
  const t = new Array(m).fill(0);
  const dfs = (mask, curMax) => {
    if (mask === fullMask) {
      if (curMax < best) best = curMax;
      return;
    }
    for (const ji of order) {
      if (mask & (1 << ji)) continue;
      const job = jobs[ji];
      for (const di of allowed[ji]) {
        const savedT = t[di];
        const end = Math.max(job.release, savedT) + job.duration;
        const newMax = Math.max(curMax, end - job.due);
        if (newMax >= best) continue;
        t[di] = end;
        const nextMask = mask | (1 << ji);
        if (lowerBound(nextMask, t, newMax) < best && insert(nextMask, t, newMax)) {
          dfs(nextMask, newMax);
        }
        t[di] = savedT;
      }
    }
  };
  dfs(0, -Infinity);
  return best;
}

function feasibleWithin(jobs, allowed, m, bound) {
  const { order, fullMask, lowerBound, insert } = makeSearch(jobs, allowed, m);
  let found = false;
  const t = new Array(m).fill(0);
  const dfs = (mask, curMax) => {
    if (found) return;
    if (mask === fullMask) {
      found = true;
      return;
    }
    for (const ji of order) {
      if (mask & (1 << ji)) continue;
      const job = jobs[ji];
      for (const di of allowed[ji]) {
        const savedT = t[di];
        const end = Math.max(job.release, savedT) + job.duration;
        const newMax = Math.max(curMax, end - job.due);
        if (newMax > bound) continue;
        t[di] = end;
        const nextMask = mask | (1 << ji);
        if (lowerBound(nextMask, t, newMax) <= bound && insert(nextMask, t, newMax)) {
          dfs(nextMask, newMax);
        }
        t[di] = savedT;
        if (found) return;
      }
    }
  };
  dfs(0, -Infinity);
  return found;
}

// Single-machine feasibility: can `jobIndices` be sequenced on one machine
// (free at t0) so that every job ends by due + bound?
function feasibleSequence(jobs, jobIndices, t0, bound) {
  const k = jobIndices.length;
  const full = (1 << k) - 1;
  const bestT = new Map();
  const dfs = (mask, t) => {
    if (mask === full) return true;
    for (let i = 0; i < k; i += 1) {
      if (mask & (1 << i)) continue;
      const job = jobs[jobIndices[i]];
      if (Math.max(job.release, t) + job.duration > job.due + bound) return false;
    }
    const prev = bestT.get(mask);
    if (prev !== undefined && prev <= t) return false;
    bestT.set(mask, t);
    for (let i = 0; i < k; i += 1) {
      if (mask & (1 << i)) continue;
      const job = jobs[jobIndices[i]];
      if (dfs(mask | (1 << i), Math.max(job.release, t) + job.duration)) return true;
    }
    return false;
  };
  return dfs(0, t0);
}

export function schedule(inputJobs, inputDevices) {
  const devices = normalizeDevices(inputDevices);
  const jobs = normalizeJobs(inputJobs, devices);
  checkFeasible(jobs);
  const inputHash = sha256(canonicalize({ devices, jobs }));
  const n = jobs.length;
  if (n === 0) {
    return {
      objective: null,
      entries: [],
      certificate: {
        algorithm: ALGORITHM_ID,
        inputHash,
        objective: null,
        tieRank: 1,
        optimalCount: 1,
      },
    };
  }
  const m = devices.length;
  const allowed = jobs.map((j) => j.devices.map((d) => devices.indexOf(d)));

  // Phase 1: exact optimal Lmax.
  const optimal = optimizeLmax(jobs, allowed, m);

  // Phase 2a: lexicographically smallest device-assignment vector among optimal plans.
  const fixed = new Array(n).fill(-1);
  for (let ji = 0; ji < n; ji += 1) {
    for (const di of allowed[ji]) {
      fixed[ji] = di;
      const restricted = allowed.map((opts, k) => (fixed[k] === -1 ? opts : [fixed[k]]));
      if (feasibleWithin(jobs, restricted, m, optimal)) break;
      fixed[ji] = -1;
    }
    if (fixed[ji] === -1) {
      throw new ScheduleError('E_INTERNAL', `assignment reconstruction failed for job ${jobs[ji].id}`);
    }
  }

  // Phase 2b: lexicographically smallest sequence per device (devices independent
  // once the assignment is fixed), in device order.
  const seqs = devices.map(() => []);
  for (let di = 0; di < m; di += 1) {
    const onDevice = [];
    for (let ji = 0; ji < n; ji += 1) {
      if (fixed[ji] === di) onDevice.push(ji);
    }
    let t = 0;
    const remaining = new Set(onDevice);
    while (remaining.size > 0) {
      let placed = false;
      for (const ji of remaining) {
        const job = jobs[ji];
        const end = Math.max(job.release, t) + job.duration;
        if (end - job.due > optimal) continue;
        const rest = [...remaining].filter((x) => x !== ji);
        if (feasibleSequence(jobs, rest, end, optimal)) {
          seqs[di].push(ji);
          remaining.delete(ji);
          t = end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        throw new ScheduleError('E_INTERNAL', `sequence reconstruction failed on device ${devices[di]}`);
      }
    }
  }

  const { entries } = simulate(jobs, devices, seqs);
  const best = {
    objective: optimal,
    assignmentKey: assignmentKey(jobs, devices, fixed),
    sequenceKey: sequenceKey(jobs, seqs),
  };
  const certificate = {
    algorithm: ALGORITHM_ID,
    inputHash,
    objective: optimal,
    tieRank: null,
    optimalCount: null,
  };
  if (n <= CERT_ENUM_LIMIT) {
    const all = enumeratePlans(jobs, devices);
    const stats = tieRankAndCount(all, best);
    certificate.tieRank = stats.tieRank;
    certificate.optimalCount = stats.optimalCount;
  }
  return { objective: optimal, entries, certificate };
}

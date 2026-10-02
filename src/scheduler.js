import {
  CHANGEOVER_MS,
  UNIT_PROCESS_MS,
  CHANGEOVER_ENERGY_TENTHS,
  UNIT_ENERGY_TENTHS,
  MAX_ENUM_JOBS,
} from './constants.js';

// Event-time interval join: pairs of half-open intervals [start,end) that overlap.
// Used to join mold-occupancy / changeover windows with maintenance windows.
export function intervalJoin(as, bs) {
  const pairs = [];
  for (const a of as) {
    for (const b of bs) {
      if (a.start < b.end && b.start < a.end) pairs.push({ a, b });
    }
  }
  return pairs;
}

// Simulate one job sequence on the single line.
// A job occupies the block [start, start + changeover + processing); the whole
// block is shifted past any overlapping maintenance window (interval join).
export function simulate(jobs, maints, horizonStart) {
  const sortedMaints = [...maints].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = horizonStart;
  let prevMold = null;
  let energyTenths = 0;
  let violations = 0;
  const entries = [];
  for (const job of jobs) {
    cursor = Math.max(cursor, job.eventTs);
    const changeoverMs = prevMold !== null && prevMold !== job.mold ? CHANGEOVER_MS : 0;
    const procMs = job.qty * UNIT_PROCESS_MS;
    let start = cursor;
    for (;;) {
      const hits = intervalJoin([{ start, end: start + changeoverMs + procMs }], sortedMaints);
      if (hits.length === 0) break;
      start = Math.max(...hits.map((h) => h.b.end));
    }
    const procStart = start + changeoverMs;
    const end = procStart + procMs;
    energyTenths += (changeoverMs ? CHANGEOVER_ENERGY_TENTHS : 0) + job.qty * UNIT_ENERGY_TENTHS;
    if (end > job.due) violations += 1;
    entries.push({
      job: job.job,
      mold: job.mold,
      qty: job.qty,
      due: job.due,
      eventTs: job.eventTs,
      start,
      changeoverEnd: changeoverMs ? procStart : null,
      end,
    });
    cursor = end;
    prevMold = job.mold;
  }
  return { entries, violations, makespan: cursor, energyTenths };
}

function* permutations(items) {
  const a = [...items];
  const n = a.length;
  const c = new Array(n).fill(0);
  yield [...a];
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [a[j], a[i]] = [a[i], a[j]];
      yield [...a];
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

const compareKey = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

function compareJobSeq(x, y) {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i].job < y[i].job) return -1;
    if (x[i].job > y[i].job) return 1;
  }
  return x.length - y.length;
}

// Optimal schedule: lexicographic objective (due violations, makespan, energy).
// All sequences tying for the best objective are returned, sorted by job name.
// <= MAX_ENUM_JOBS jobs: exhaustive enumeration; otherwise greedy by due date.
export function schedule(orders, maints, horizonStart) {
  const jobs = [...orders];
  if (jobs.length === 0) {
    return { objective: { violations: 0, makespan: horizonStart, energy: 0 }, sequences: [[]] };
  }
  let candidates;
  if (jobs.length <= MAX_ENUM_JOBS) {
    candidates = permutations(jobs);
  } else {
    candidates = [[...jobs].sort((a, b) => a.due - b.due || (a.job < b.job ? -1 : a.job > b.job ? 1 : 0))];
  }
  let bestKey = null;
  const bestRuns = [];
  for (const perm of candidates) {
    const run = simulate(perm, maints, horizonStart);
    const key = [run.violations, run.makespan, run.energyTenths];
    const cmp = bestKey === null ? -1 : compareKey(key, bestKey);
    if (cmp < 0) {
      bestKey = key;
      bestRuns.length = 0;
      bestRuns.push(run);
    } else if (cmp === 0) {
      bestRuns.push(run);
    }
  }
  bestRuns.sort((x, y) => compareJobSeq(x.entries, y.entries));
  return {
    objective: { violations: bestKey[0], makespan: bestKey[1], energy: bestKey[2] / 10 },
    sequences: bestRuns.map((r) => r.entries),
  };
}

'use strict';

const { SchedError } = require('./errors');
const { prepareInput, firstUnschedulableJob, inputHashOf } = require('./scheduler');

const MAX_BRUTE_FORCE_JOBS = 8;

function permutations(n) {
  const result = [];
  const used = new Array(n).fill(false);
  const cur = [];
  (function rec() {
    if (cur.length === n) {
      result.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  })();
  return result;
}

function cmpArr(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// Independent exhaustive verifier: enumerates every device assignment (2^n)
// and every job permutation (n!), simulates each candidate, and selects the
// best plan under the canonical total order:
//   (Lmax, assignment tuple, l0, t0, l1, t1, seq0, seq1)
function bruteForce(input) {
  const { jobs, devices } = prepareInput(input);
  const n = jobs.length;
  if (n > MAX_BRUTE_FORCE_JOBS) {
    throw new SchedError('E_UNSUPPORTED', `brute-force verifier supports at most ${MAX_BRUTE_FORCE_JOBS} jobs`);
  }
  const certificateBase = {
    algorithm: 'exhaustive-dfs',
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
  const eligible = devices.map((d) =>
    jobs.map((j) => j.devices === null || j.devices.includes(d.id))
  );
  const size = 1 << n;
  const perms = permutations(n);
  const maskBest = new Array(size).fill(Infinity);
  let best = null;
  for (let mask = 0; mask < size; mask++) {
    const bits = [];
    for (let j = 0; j < n; j++) bits.push((mask >> j) & 1);
    for (const perm of perms) {
      const t = [0, 0];
      const l = [-Infinity, -Infinity];
      const seqs = [[], []];
      let feasible = true;
      for (const j of perm) {
        const m = bits[j];
        if (!eligible[m][j]) {
          feasible = false;
          break;
        }
        const job = jobs[j];
        const start = Math.max(t[m], job.release);
        const end = start + job.duration;
        if (end > horizons[m]) {
          feasible = false;
          break;
        }
        t[m] = end;
        const lat = end - job.due;
        if (lat > l[m]) l[m] = lat;
        seqs[m].push(j);
      }
      if (!feasible) continue;
      const L = Math.max(l[0], l[1]);
      if (L < maskBest[mask]) maskBest[mask] = L;
      const key = [L, ...bits, l[0], t[0], l[1], t[1], ...seqs[0], ...seqs[1]];
      if (best === null || cmpArr(key, best.key) < 0) {
        best = { key, L, mask, seqs };
      }
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
    if (maskBest[mask] === best.L) {
      tieCount++;
      let less = false;
      for (let j = 0; j < n; j++) {
        const a = (mask >> j) & 1;
        const b = (best.mask >> j) & 1;
        if (a !== b) {
          less = a < b;
          break;
        }
      }
      if (less) tieRank++;
    }
  }
  tieRank += 1;
  const schedule = {};
  for (let m = 0; m < 2; m++) {
    let t = 0;
    schedule[devices[m].id] = best.seqs[m].map((j) => {
      const job = jobs[j];
      const start = Math.max(t, job.release);
      const end = start + job.duration;
      t = end;
      return { jobId: job.id, start, end };
    });
  }
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

// Structural comparison of a DP plan against a brute-force plan.
function plansMatch(dpPlan, bfPlan) {
  const diffs = [];
  if (dpPlan.objective !== bfPlan.objective) {
    diffs.push(`objective: dp=${dpPlan.objective} dfs=${bfPlan.objective}`);
  }
  if (dpPlan.certificate.tieCount !== bfPlan.certificate.tieCount) {
    diffs.push(`tieCount: dp=${dpPlan.certificate.tieCount} dfs=${bfPlan.certificate.tieCount}`);
  }
  if (dpPlan.certificate.tieRank !== bfPlan.certificate.tieRank) {
    diffs.push(`tieRank: dp=${dpPlan.certificate.tieRank} dfs=${bfPlan.certificate.tieRank}`);
  }
  if (dpPlan.certificate.inputHash !== bfPlan.certificate.inputHash) {
    diffs.push('inputHash mismatch');
  }
  if (JSON.stringify(dpPlan.assignments) !== JSON.stringify(bfPlan.assignments)) {
    diffs.push(`assignments: dp=${JSON.stringify(dpPlan.assignments)} dfs=${JSON.stringify(bfPlan.assignments)}`);
  }
  if (JSON.stringify(dpPlan.schedule) !== JSON.stringify(bfPlan.schedule)) {
    diffs.push(`schedule: dp=${JSON.stringify(dpPlan.schedule)} dfs=${JSON.stringify(bfPlan.schedule)}`);
  }
  return { match: diffs.length === 0, diffs };
}

module.exports = { bruteForce, plansMatch, MAX_BRUTE_FORCE_JOBS };

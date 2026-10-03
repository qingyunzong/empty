'use strict';

function keyOf(job) {
  return [job.deadline, job.tenant, job.packId].join('|');
}

function waitedOf(job, now) {
  return Math.max(0, now - job.enqueuedAt);
}

function isBoosted(job, now, waitThreshold) {
  return waitThreshold > 0 && waitedOf(job, now) >= waitThreshold;
}

function compareJobs(a, b, now, waitThreshold) {
  const ab = isBoosted(a, now, waitThreshold) ? 0 : 1;
  const bb = isBoosted(b, now, waitThreshold) ? 0 : 1;
  if (ab !== bb) return ab - bb;
  if (ab === 0 && a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  if (a.deadline !== b.deadline) return a.deadline - b.deadline;
  return a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0;
}

function pickWorker(job, workers, used) {
  let best = -1;
  let bestLoad = Infinity;
  for (let i = 0; i < workers.length; i++) {
    if (workers[i].maxClassification < job.classification) continue;
    if (used[i] + job.size > workers[i].throughput) continue;
    const load = used[i] / workers[i].throughput;
    if (load < bestLoad) {
      bestLoad = load;
      best = i;
    }
  }
  return best;
}

function runPass(orderedJobs, workers, now, waitThreshold, initialUsed) {
  const used = initialUsed ? [...initialUsed] : new Array(workers.length).fill(0);
  const assignments = [];
  const deferred = [];
  for (const job of orderedJobs) {
    const w = pickWorker(job, workers, used);
    if (w < 0) {
      deferred.push({ packId: job.packId, tenant: job.tenant, reason: 'no-capacity-or-clearance' });
      continue;
    }
    used[w] += job.size;
    assignments.push({
      packId: job.packId,
      tenant: job.tenant,
      workerId: workers[w].id,
      boosted: isBoosted(job, now, waitThreshold),
      waited: waitedOf(job, now),
    });
  }
  return { assignments, deferred };
}

const ENUM_LIMIT = 9;

function schedule(jobs, workers, opts = {}) {
  const waitThreshold = opts.waitThreshold || 0;
  const now = opts.now || 0;
  if (jobs.length <= ENUM_LIMIT && jobs.length > 0) {
    const best = enumerateOptimal(jobs, workers, opts);
    const chosen = new Set(best.assignments.map((a) => a.packId));
    const deferred = jobs
      .filter((j) => !chosen.has(j.packId))
      .map((j) => ({ packId: j.packId, tenant: j.tenant, reason: 'no-capacity-or-clearance' }));
    return { assignments: best.assignments, deferred, optimal: true, maxOnTime: best.maxOnTime };
  }
  const ordered = [...jobs].sort((a, b) => compareJobs(a, b, now, waitThreshold));
  const result = runPass(ordered, workers, now, waitThreshold, opts.initialUsed);
  result.optimal = false;
  return result;
}

function* permutations(items) {
  const a = items.slice();
  const n = a.length;
  const c = new Array(n).fill(0);
  yield a.slice();
  let i = 1;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      const tmp = a[j];
      a[j] = a[i];
      a[i] = tmp;
      yield a.slice();
      c[i] += 1;
      i = 1;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

function betterTuple(candidate, best) {
  if (best === null) return true;
  if (candidate.count !== best.count) return candidate.count > best.count;
  if (candidate.boosted !== best.boosted) return candidate.boosted > best.boosted;
  return candidate.keysStr < best.keysStr;
}

function enumerateOptimal(jobs, workers, opts = {}) {
  if (jobs.length > 9) throw new Error('enumeration supports n<=9');
  const waitThreshold = opts.waitThreshold || 0;
  const now = opts.now || 0;
  let best = null;
  let bestAssignments = [];
  for (const perm of permutations(jobs)) {
    const result = runPass(perm, workers, now, waitThreshold, opts.initialUsed);
    const keys = result.assignments
      .map((a) => keyOf(jobs.find((j) => j.packId === a.packId)))
      .sort();
    const candidate = {
      count: keys.length,
      boosted: result.assignments.filter((a) => a.boosted).length,
      keysStr: keys.join(','),
    };
    if (betterTuple(candidate, best)) {
      best = candidate;
      bestAssignments = result.assignments;
    }
  }
  return {
    maxOnTime: best ? best.count : 0,
    scheduledKeys: best ? best.keysStr.split(',').filter(Boolean) : [],
    assignments: bestAssignments,
  };
}

module.exports = { schedule, enumerateOptimal, compareJobs, isBoosted, keyOf, ENUM_LIMIT };

'use strict';

// Constraint scheduler: security level x worker x deadline.
//
// A package is { id, size, level, deadline, boosted }.
// A worker is { id, throughput, maxLevel }.
// startTimes maps workerId -> tick at which the worker becomes available.
//
// A package may run only on a worker with maxLevel >= package.level.
// Boosted (anti-starvation) packages get scheduling priority, but boosting
// never relaxes the security-level constraint.
//
// Objective (lexicographic):
//   1. maximize number of boosted packages scheduled
//   2. maximize number of on-time completions (finish <= deadline)
//   3. minimize total completion time (deterministic tie-break)

const EXACT_LIMIT = 12;

function cmpScore(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Exact optimizer (used when packages.length <= EXACT_LIMIT).
// Memoized DFS over (placedMask, workerTimes): because every package is
// available immediately and there are no future releases, the future only
// depends on which packages are placed and each worker's elapsed time.
function scheduleExact(packages, workers, startTimes) {
  const pkgs = [...packages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = pkgs.length;
  const w = workers.length;
  const dur = pkgs.map((p) => workers.map((wk) => Math.ceil(p.size / wk.throughput)));
  const eligible = pkgs.map((p) => workers.map((wk) => wk.maxLevel >= p.level));
  const initial = workers.map((wk) => startTimes[wk.id] || 0);
  const memo = new Map();

  function dfs(mask, times) {
    if (mask === (1 << n) - 1) return { score: [0, 0, 0], choice: null };
    const key = mask + '|' + times.join(',');
    const hit = memo.get(key);
    if (hit) return hit;
    let best = null;
    // Place any unplaced package on any eligible worker (at its earliest time).
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) continue;
      for (let j = 0; j < w; j += 1) {
        if (!eligible[i][j]) continue;
        const finish = times[j] + dur[i][j];
        const next = times.slice();
        next[j] = finish;
        const sub = dfs(mask | (1 << i), next);
        const score = [
          sub.score[0] + (pkgs[i].boosted ? 1 : 0),
          sub.score[1] + (finish <= pkgs[i].deadline ? 1 : 0),
          sub.score[2] - finish,
        ];
        if (!best || cmpScore(score, best.score) > 0) {
          best = { score, choice: { pkg: i, worker: j, finish } };
        }
      }
    }
    // Or leave a package unscheduled this round.
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) continue;
      const sub = dfs(mask | (1 << i), times);
      if (!best || cmpScore(sub.score, best.score) > 0) {
        best = { score: sub.score, choice: { pkg: i, worker: -1, finish: 0 } };
      }
    }
    memo.set(key, best);
    return best;
  }

  const assignments = new Map();
  let mask = 0;
  let times = initial.slice();
  for (;;) {
    const node = dfs(mask, times);
    if (!node.choice) break;
    const { pkg, worker, finish } = node.choice;
    mask |= 1 << pkg;
    if (worker >= 0) {
      const start = times[worker];
      times[worker] = finish;
      assignments.set(pkgs[pkg].id, {
        pkgId: pkgs[pkg].id,
        workerId: workers[worker].id,
        start,
        finish,
        onTime: finish <= pkgs[pkg].deadline,
      });
    }
  }
  const finalNode = dfs(0, initial.slice());
  return {
    assignments,
    boostedScheduled: finalNode.score[0],
    onTime: finalNode.score[1],
  };
}

// Greedy list scheduling for large batches.
function scheduleGreedy(packages, workers, startTimes) {
  const order = [...packages].sort((a, b) => {
    if (!!b.boosted !== !!a.boosted) return a.boosted ? -1 : 1;
    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const times = workers.map((wk) => startTimes[wk.id] || 0);
  const assignments = new Map();
  let onTime = 0;
  let boostedScheduled = 0;
  for (const p of order) {
    let bestJ = -1;
    let bestFinish = Infinity;
    for (let j = 0; j < workers.length; j += 1) {
      if (workers[j].maxLevel < p.level) continue;
      const finish = times[j] + Math.ceil(p.size / workers[j].throughput);
      if (finish < bestFinish) {
        bestFinish = finish;
        bestJ = j;
      }
    }
    if (bestJ < 0) continue;
    const start = times[bestJ];
    times[bestJ] = bestFinish;
    const ok = bestFinish <= p.deadline;
    if (ok) onTime += 1;
    if (p.boosted) boostedScheduled += 1;
    assignments.set(p.id, {
      pkgId: p.id,
      workerId: workers[bestJ].id,
      start,
      finish: bestFinish,
      onTime: ok,
    });
  }
  return { assignments, boostedScheduled, onTime };
}

function schedule(packages, workers, startTimes) {
  if (packages.length <= EXACT_LIMIT) return scheduleExact(packages, workers, startTimes);
  return scheduleGreedy(packages, workers, startTimes);
}

module.exports = { schedule, scheduleExact, scheduleGreedy, EXACT_LIMIT };

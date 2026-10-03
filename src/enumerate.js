"use strict";

// Exact minimum-makespan oracle for small n (<= 8 tasks), used to
// cross-check the scheduler. Ignores priority/budget: pure sequencing with
// temperature-switch cooldowns on identical parallel channels.
//
// best[mask] = min time to run exactly the task set `mask` on one channel
// (subset DP over last task). Then channels are filled by recursive
// min-max partitioning of the full set.

function taskDuration(task, cooldown) {
  let d = 0;
  const segs = task.segments;
  for (let i = 0; i < segs.length; i++) {
    d += segs[i].duration;
    if (i > 0 && segs[i].temp !== segs[i - 1].temp) d += cooldown;
  }
  return d;
}

function optimalMakespan(tasks, numChannels, config = {}) {
  const cooldown = config.cooldown ?? 5;
  const initialTemp = config.initialTemp ?? 25;
  const n = tasks.length;
  if (n === 0) return 0;
  const dur = tasks.map((t) => taskDuration(t, cooldown));
  const first = tasks.map((t) => t.segments[0].temp);
  const last = tasks.map((t) => t.segments[t.segments.length - 1].temp);
  const cd = (a, b) => (a === b ? 0 : cooldown);
  const size = 1 << n;
  const best = new Array(size).fill(Infinity);
  best[0] = 0;
  const dp = new Array(size);
  for (let mask = 1; mask < size; mask++) {
    dp[mask] = new Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const prev = mask ^ (1 << i);
      let v;
      if (prev === 0) {
        v = cd(initialTemp, first[i]) + dur[i];
      } else {
        v = Infinity;
        for (let j = 0; j < n; j++) {
          if (!(prev & (1 << j))) continue;
          const t = dp[prev][j] + cd(last[j], first[i]) + dur[i];
          if (t < v) v = t;
        }
      }
      dp[mask][i] = v;
      if (v < best[mask]) best[mask] = v;
    }
  }
  const memo = new Map();
  function partition(mask, k) {
    if (mask === 0) return 0;
    if (k === 1) return best[mask];
    const key = mask * 16 + k;
    if (memo.has(key)) return memo.get(key);
    const low = mask & -mask; // symmetry break: lowest task always in `s`
    let ans = Infinity;
    for (let s = (mask - 1) & mask; s > 0; s = (s - 1) & mask) {
      if (!(s & low)) continue;
      const t = Math.max(best[s], partition(mask ^ s, k - 1));
      if (t < ans) ans = t;
    }
    memo.set(key, ans);
    return ans;
  }
  return partition(size - 1, numChannels);
}

module.exports = { optimalMakespan };

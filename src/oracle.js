// Brute-force oracle for acceptance checking on small instances (n <= 12).
//
// A served pass starts at max(windowStart, prevEnd + setup) and downlinks for
// min(remaining window, floor(onboard / rate)) whole seconds, exactly like the
// greedy scheduler (quotas/fairness/preemption are out of scope here). Because
// an onboard-capped pass frees the antenna early, the end time of a sequence
// is not determined by its last pass alone; dp[mask][last] therefore keeps a
// Pareto frontier of (end, bytes) pairs (an entry dominates another when it
// ends no later with at least as many bytes).

export function maxValidBytes(windows, setup) {
  const n = windows.length;
  if (n === 0) return 0;
  if (n > 20) throw new Error('oracle is only meant for small n');
  const size = 1 << n;
  const dp = Array.from({ length: size }, () => new Array(n).fill(null));

  const onboardSec = windows.map((w) => Math.floor(w.onboard / w.rate));

  // Merge (end, bytes) into a frontier sorted by end asc, bytes asc.
  const merge = (frontier, end, bytes) => {
    for (const e of frontier) {
      if (e.end <= end && e.bytes >= bytes) return frontier; // dominated
    }
    const kept = frontier.filter((e) => !(e.end >= end && e.bytes <= bytes));
    kept.push({ end, bytes });
    kept.sort((a, b) => a.end - b.end || a.bytes - b.bytes);
    return kept;
  };

  let best = 0;
  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const w = windows[last];
      let frontier = [];
      if ((mask & (mask - 1)) === 0) {
        const serve = Math.min(w.end - w.start, onboardSec[last]);
        if (serve > 0) frontier = merge(frontier, w.start + serve, w.rate * serve);
      } else {
        const rest = mask ^ (1 << last);
        for (let prev = 0; prev < n; prev++) {
          if (!(rest & (1 << prev))) continue;
          for (const e of dp[rest][prev] ?? []) {
            const start = Math.max(w.start, e.end + setup);
            const serve = Math.min(w.end - start, onboardSec[last]);
            if (serve <= 0) continue;
            frontier = merge(frontier, start + serve, e.bytes + w.rate * serve);
          }
        }
      }
      dp[mask][last] = frontier;
      for (const e of frontier) if (e.bytes > best) best = e.bytes;
    }
  }
  return best;
}

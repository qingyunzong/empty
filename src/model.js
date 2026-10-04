// Physical model: co-firing compatibility, run power profiles, schedule power stats.
import { EPS } from './curve.js';

export function alloysCompatible(a, b, config) {
  if (a === b) return true;
  return (config.alloyGroups || []).some(
    (g) => Array.isArray(g) && g.includes(a) && g.includes(b)
  );
}

// Pairwise temperature spread of two compiled curves over their common active window.
function pairTempOk(ca, cb, maxDiff) {
  const lim = Math.min(ca.duration, cb.duration);
  const pts = new Set([0, lim]);
  for (const b of ca.breakpoints) if (b > 0 && b < lim) pts.add(b);
  for (const b of cb.breakpoints) if (b > 0 && b < lim) pts.add(b);
  for (const t of pts) {
    if (Math.abs(ca.tempAt(t) - cb.tempAt(t)) > maxDiff + EPS) return false;
  }
  return true;
}

// Can the given batch indices share one furnace run?
export function runFeasible(idxs, batches, config) {
  let load = 0;
  let lo = -Infinity;
  let hi = Infinity;
  for (const i of idxs) {
    const b = batches[i];
    load += b.load;
    lo = Math.max(lo, b.tempBand[0]);
    hi = Math.min(hi, b.tempBand[1]);
  }
  if (load > config.capacity + EPS) return false; // 装炉量限制
  if (lo > hi + EPS) return false; // 温度带必须相交
  for (let a = 0; a < idxs.length; a++) {
    for (let b = a + 1; b < idxs.length; b++) {
      if (!alloysCompatible(batches[idxs[a]].alloy, batches[idxs[b]].alloy, config)) return false;
      if (!pairTempOk(batches[idxs[a]].compiled, batches[idxs[b]].compiled, config.maxTempDiff)) {
        return false; // 同炉温差限制
      }
    }
  }
  return true;
}

// Power profile of one run (all batches start together at run start).
export function runProfile(idxs, batches) {
  const comps = idxs.map((i) => batches[i].compiled);
  const duration = Math.max(...comps.map((c) => c.duration));
  const bpSet = new Set([0, duration]);
  for (const c of comps) for (const b of c.breakpoints) if (b > 0 && b < duration) bpSet.add(b);
  const breakpoints = [...bpSet].sort((a, b) => a - b);
  const powerAt = (tau) => {
    let s = 0;
    for (const c of comps) {
      if (tau <= c.duration + EPS) s += c.powerAt(Math.min(Math.max(tau, 0), c.duration));
    }
    return s;
  };
  let peak = 0;
  for (const t of breakpoints) peak = Math.max(peak, powerAt(t));
  return { duration, breakpoints, powerAt, peak };
}

// Total power at global time t as one-sided limits:
//   left:  t -> t^- (runs with start < t <= start+duration contribute)
//   right: t -> t^+ (runs with start <= t < start+duration contribute; this is
//          also the pointwise value on the half-open convention [start, start+duration))
// Between consecutive breakpoints the total is linear, so the extremes over the
// horizon are exactly the extremes of these one-sided limits at breakpoints.
export function powerLimitsAt(placed, t) {
  let left = 0;
  let right = 0;
  for (const p of placed) {
    const tau = t - p.start;
    if (tau > EPS && tau <= p.profile.duration + EPS) {
      left += p.profile.powerAt(Math.min(tau, p.profile.duration));
    }
    if (tau >= -EPS && tau < p.profile.duration - EPS) {
      right += p.profile.powerAt(Math.max(tau, 0));
    }
  }
  return { left, right };
}

export function breakpointsOf(placed) {
  const bps = new Set([0]);
  for (const p of placed) {
    bps.add(p.start);
    bps.add(p.start + p.profile.duration);
    for (const b of p.profile.breakpoints) bps.add(p.start + b);
  }
  return [...bps].sort((a, b) => a - b);
}

export function maxClosedPower(placed) {
  let m = 0;
  for (const t of breakpointsOf(placed)) {
    const { left, right } = powerLimitsAt(placed, t);
    m = Math.max(m, left, right);
  }
  return m;
}

// { makespan, max, min } of the total power profile over [0, makespan).
export function scheduleStats(placed) {
  let makespan = 0;
  for (const p of placed) makespan = Math.max(makespan, p.start + p.profile.duration);
  let max = 0;
  let min = Infinity;
  for (const t of breakpointsOf(placed)) {
    if (t > makespan + EPS) continue;
    const { left, right } = powerLimitsAt(placed, t);
    max = Math.max(max, left, right);
    if (t > EPS && t <= makespan + EPS) min = Math.min(min, left);
    if (t < makespan - EPS) min = Math.min(min, right);
  }
  if (!Number.isFinite(min)) min = 0;
  return { makespan, max, min };
}

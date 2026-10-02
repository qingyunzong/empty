'use strict';

// Exact interval scheduling with per-target switch costs.
//
// Objective (lexicographic):
//   1. maximize total science value;
//   2. fairness: minimize the maximum PI quota deficit
//      (deficit_pi = max(0, quota_pi - accruedExposure_pi)), then the sum of deficits;
//   3. deterministic tie-break: lexicographically smallest sorted target-id list.
//
// The exact solver is a DP over (remaining-target mask, segment, time).
// Key insight: at a given mask the used-target set is fixed, so per-PI exposure
// of the prefix is fixed and the lexicographic comparison of suffixes is exact.
// Exact solving is used for n <= EXACT_LIMIT (acceptance requires n <= 10);
// beyond that a deterministic greedy fallback is used.

const EXACT_LIMIT = 20;

function compareIds(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function insertSorted(id, ids) {
  const out = ids.slice();
  let i = 0;
  while (i < out.length && out[i] < id) i++;
  out.splice(i, 0, id);
  return out;
}

function addExpo(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = (out[k] || 0) + b[k];
  return out;
}

function deficitStats(quotas, baseExpo, extraExpo) {
  let maxDeficit = 0;
  let sumDeficit = 0;
  for (const pi of Object.keys(quotas)) {
    const got = (baseExpo[pi] || 0) + (extraExpo[pi] || 0);
    const d = Math.max(0, quotas[pi] - got);
    if (d > maxDeficit) maxDeficit = d;
    sumDeficit += d;
  }
  return [maxDeficit, sumDeficit];
}

function makeComparator(quotas, prefixExpo) {
  return (c1, c2) => {
    if (c1.value !== c2.value) return c2.value - c1.value;
    const [m1, s1] = deficitStats(quotas, prefixExpo, c1.expo);
    const [m2, s2] = deficitStats(quotas, prefixExpo, c2.expo);
    if (m1 !== m2) return m1 - m2;
    if (s1 !== s2) return s1 - s2;
    return compareIds(c1.ids, c2.ids);
  };
}

function solveExact(sorted, bounds, quotas, fixedExpo) {
  const n = sorted.length;
  const full = (1 << n) - 1;
  const expoMask = new Array(1 << n).fill(null);
  expoMask[0] = {};
  function expoOf(mask) {
    const cached = expoMask[mask];
    if (cached) return cached;
    const bit = mask & -mask;
    const idx = 31 - Math.clz32(bit);
    const rest = expoOf(mask ^ bit);
    const t = sorted[idx];
    const out = { ...rest };
    out[t.pi] = (out[t.pi] || 0) + t.duration;
    expoMask[mask] = out;
    return out;
  }

  const memo = new Map();
  function dfs(mask, seg, time) {
    const key = mask + '|' + seg + '|' + time;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const prefix = addExpo(fixedExpo, expoOf(full ^ mask));
    const cmp = makeComparator(quotas, prefix);
    let best = { value: 0, expo: {}, ids: [], placements: [] };
    if (seg + 1 < bounds.length) {
      best = dfs(mask, seg + 1, bounds[seg + 1].start);
    }
    const segEnd = bounds[seg].end;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      const t = sorted[i];
      for (const w of t.windows) {
        const start = Math.max(w[0], time + t.switch);
        const end = start + t.duration;
        if (end > Math.min(w[1], segEnd)) continue;
        const sub = dfs(mask ^ bit, seg, end);
        const cand = {
          value: t.value + sub.value,
          expo: addExpo({ [t.pi]: t.duration }, sub.expo),
          ids: insertSorted(t.id, sub.ids),
          placements: [{ target: t.id, pi: t.pi, start, end, value: t.value }, ...sub.placements],
        };
        if (cmp(cand, best) < 0) best = cand;
      }
    }
    memo.set(key, best);
    return best;
  }
  return dfs(full, 0, -Infinity);
}

function earliestSlot(t, busy) {
  let best = null;
  for (const w of t.windows) {
    let s = w[0];
    for (const b of busy) {
      if (b.end + t.switch <= s) continue;
      if (s + t.duration <= b.start) break;
      s = b.end + t.switch;
    }
    if (s + t.duration <= w[1] && (best === null || s < best)) best = s;
  }
  return best;
}

function solveGreedy(sorted, fixedSorted) {
  const order = sorted.slice().sort((a, b) =>
    b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const busy = fixedSorted.map(f => ({ start: f.start, end: f.end }))
    .sort((a, b) => a.start - b.start);
  const placements = [];
  for (const t of order) {
    const s = earliestSlot(t, busy);
    if (s === null) continue;
    placements.push({ target: t.id, pi: t.pi, start: s, end: s + t.duration, value: t.value });
    busy.push({ start: s, end: s + t.duration });
    busy.sort((a, b) => a.start - b.start);
  }
  placements.sort((a, b) => a.start - b.start || (a.target < b.target ? -1 : 1));
  return { placements, value: placements.reduce((sum, p) => sum + p.value, 0) };
}

// targets: [{id, pi, duration, value, switch, windows:[[s,e],...]}]
// fixed:   [{id, target, pi, start, end, value}]  confirmed observations (immutable)
// quotas:  {pi: quota}
// returns { placements, value, fixedExpo }
function solveSchedule(targets, fixed, quotas) {
  const sorted = targets.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const t of sorted) {
    t.windows = t.windows.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  const fixedSorted = fixed.slice().sort((a, b) =>
    a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fixedExpo = {};
  for (const f of fixedSorted) fixedExpo[f.pi] = (fixedExpo[f.pi] || 0) + (f.end - f.start);

  if (sorted.length > EXACT_LIMIT) {
    const r = solveGreedy(sorted, fixedSorted);
    return { placements: r.placements, value: r.value, fixedExpo };
  }

  const bounds = [];
  let cursor = -Infinity;
  for (const f of fixedSorted) {
    bounds.push({ start: cursor, end: f.start });
    cursor = f.end;
  }
  bounds.push({ start: cursor, end: Infinity });

  const r = solveExact(sorted, bounds, quotas || {}, fixedExpo);
  return { placements: r.placements, value: r.value, fixedExpo };
}

module.exports = { solveSchedule, compareIds, EXACT_LIMIT };

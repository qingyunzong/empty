import { ZERO, add, cmp, maxRat, ratToString } from './rational.js';

function lexCmpIds(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

// Exact solver for 1 | r_j, p_j, non-preemptive | max sum w_j.
// Feasibility of a subset is decided by the exact subset DP
//   F(S) = min over j in S of max(F(S\{j}), r_j) + p_j   (kept only if <= d_j)
// which is exact because in any feasible schedule some job finishes last.
// Complexity: O(2^n * n) time, O(2^n) space -- the problem is NP-hard,
// so this targets the small offline batches of a stamping shop.
export function solveTasks(tasks) {
  const list = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = list.length;
  if (n > 30) {
    throw new Error(`exact solver supports at most 30 tasks, got ${n}`);
  }
  const size = 1 << n;
  // minEnd[mask]: undefined = infeasible, null = empty set ("-inf"), otherwise a rational.
  const minEnd = new Array(size);
  const choice = new Int32Array(size).fill(-1);
  const wsum = new Array(size);
  minEnd[0] = null;
  wsum[0] = ZERO;

  for (let mask = 1; mask < size; mask++) {
    const lsb = mask & -mask;
    const li = 31 - Math.clz32(lsb);
    wsum[mask] = add(wsum[mask ^ lsb], list[li].weight);
    let best;
    let bestJ = -1;
    for (let j = 0; j < n; j++) {
      const bit = 1 << j;
      if (!(mask & bit)) continue;
      const prev = minEnd[mask ^ bit];
      if (prev === undefined) continue;
      const t = list[j];
      const start = prev === null ? t.release : maxRat(prev, t.release);
      const end = add(start, t.duration);
      if (cmp(end, t.deadline) > 0) continue;
      if (best === undefined || cmp(end, best) < 0) {
        best = end;
        bestJ = j;
      }
    }
    minEnd[mask] = best;
    choice[mask] = bestJ;
  }

  const idsOf = (mask) => {
    const ids = [];
    for (let j = 0; j < n; j++) if (mask & (1 << j)) ids.push(list[j].id);
    return ids;
  };

  let bestMask = -1;
  let bestIds = null;
  for (let mask = 0; mask < size; mask++) {
    if (minEnd[mask] === undefined) continue;
    if (bestMask < 0) {
      bestMask = mask;
      bestIds = idsOf(mask);
      continue;
    }
    const c = cmp(wsum[mask], wsum[bestMask]);
    if (c > 0) {
      bestMask = mask;
      bestIds = idsOf(mask);
    } else if (c === 0) {
      const ids = idsOf(mask);
      if (lexCmpIds(ids, bestIds) < 0) {
        bestMask = mask;
        bestIds = ids;
      }
    }
  }

  // Reconstruct the achieving order (collected last-to-first) and left-shift it.
  const order = [];
  for (let m = bestMask; m !== 0; m ^= 1 << choice[m]) order.push(choice[m]);
  order.reverse();
  const selected = [];
  let prev = null;
  for (const j of order) {
    const t = list[j];
    const start = prev === null ? t.release : maxRat(prev, t.release);
    const end = add(start, t.duration);
    selected.push({ id: t.id, start, end });
    prev = end;
  }

  // Certificate: for every unselected task, the selected tasks whose windows
  // [release, deadline) strictly intersect its own window.
  const selectedSet = new Set(bestIds);
  const certificate = {};
  for (const t of list) {
    if (selectedSet.has(t.id)) continue;
    certificate[t.id] = list
      .filter(
        (s) =>
          selectedSet.has(s.id) &&
          cmp(s.release, t.deadline) < 0 &&
          cmp(t.release, s.deadline) < 0
      )
      .map((s) => s.id);
  }

  return {
    selected: selected.map((s) => ({
      id: s.id,
      start: ratToString(s.start),
      end: ratToString(s.end),
    })),
    weight: ratToString(wsum[bestMask]),
    certificate,
  };
}

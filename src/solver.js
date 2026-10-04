'use strict';

// Exact solver for the mold-plan scheduling problem.
//
// Model:
//   - Each job belongs to a mold, consumes `shots` of mold life and `duration`
//     minutes of shift capacity.
//   - Each shift has a capacity budget (minutes). Locked/unlocked maintenance
//     windows consume capacity of the shift they are booked in.
//   - The first job of a shift pays its mold's setup cost; consecutive jobs in
//     the same shift pay changeover[prevMold][nextMold] when molds differ.
//   - Mold life is a global budget: total shots per mold must not exceed life.
//
// Objective: minimize total setup + changeover minutes. Ties are broken by a
// fixed rule: the lexicographically smallest canonical plan string
// ("SHIFT:JOB,JOB|SHIFT:JOB|..."), so equal-optima instances always yield the
// same plan regardless of insertion order.
//
// The solver is exact (subset DP). Memo tables may be shared across calls via
// opts.memo so the planner can recompute incrementally; keys are content
// based (shift index + sorted job-id list), so entries stay valid as long as
// job/mold/shift data is unchanged (the planner invalidates on mutation).

const INF = Infinity;
const MAX_EXACT_JOBS = 24;

function sortedIds(obj) {
  return Object.keys(obj).sort();
}

function emptyState() {
  return {
    molds: {},
    jobs: {},
    shifts: {},
    setup: {},
    changeover: {},
    maintenance: [],
    pinned: {},
    pinMeta: {},
    pending: []
  };
}

function setupCost(state, mold) {
  const v = state.setup[mold];
  return v == null ? 0 : v;
}

function changeoverCost(state, from, to) {
  const row = state.changeover[from];
  if (!row) return 0;
  const v = row[to];
  return v == null ? 0 : v;
}

function compareCandidate(a, b) {
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.str < b.str) return -1;
  if (a.str > b.str) return 1;
  return 0;
}

function solve(state, opts = {}) {
  const memo = opts.memo || { order: new Map(), assign: new Map() };
  const stats = opts.stats || { order: 0, assign: 0 };
  const pending = new Set(state.pending || []);
  const shiftIds = sortedIds(state.shifts);
  const jobIds = sortedIds(state.jobs).filter((j) => !pending.has(j));

  if (jobIds.length > MAX_EXACT_JOBS) {
    throw new Error(`exact solver supports at most ${MAX_EXACT_JOBS} jobs, got ${jobIds.length}`);
  }

  const infeasible = (reason) => ({
    feasible: false, reason, cost: null, plan: null, planStr: null, stats
  });

  // Global mold-life budget.
  const usage = {};
  for (const id of jobIds) {
    const job = state.jobs[id];
    usage[job.mold] = (usage[job.mold] || 0) + job.shots;
  }
  for (const mold of Object.keys(usage)) {
    const life = state.molds[mold] ? state.molds[mold].life : 0;
    if (usage[mold] > life) return infeasible(`mold-life-exceeded:${mold}`);
  }

  // Effective shift capacities (maintenance consumes budget).
  const caps = shiftIds.map((s) => {
    let cap = state.shifts[s].capacity;
    for (const m of state.maintenance) {
      if (m.shift === s) cap -= m.duration;
    }
    return cap;
  });

  // Pins: job -> fixed shift.
  const pinOf = shiftIds.map(() => []);
  for (const [job, shift] of Object.entries(state.pinned || {})) {
    if (pending.has(job)) continue;
    const si = shiftIds.indexOf(shift);
    if (si < 0) return infeasible(`unknown-pin-shift:${shift}`);
    pinOf[si].push(job);
  }

  // Min-cost feasible ordering of `ids` inside shift `si` (subset DP with
  // lexicographic tie-break on the job-id sequence). Null when over budget.
  function bestOrder(ids, si) {
    const key = si + '|' + ids.join(',');
    if (memo.order.has(key)) return memo.order.get(key);
    stats.order += 1;
    const m = ids.length;
    const size = 1 << m;
    const cost = new Array(size).fill(INF);
    const seq = new Array(size).fill(null);
    cost[0] = 0;
    seq[0] = [];
    for (let mask = 1; mask < size; mask++) {
      let bestC = INF;
      let bestS = null;
      for (let j = 0; j < m; j++) {
        const bit = 1 << j;
        if (!(mask & bit)) continue;
        const prev = mask ^ bit;
        if (cost[prev] === INF) continue;
        const job = state.jobs[ids[j]];
        const prevSeq = seq[prev];
        const add = prevSeq.length === 0
          ? setupCost(state, job.mold)
          : changeoverCost(state, state.jobs[prevSeq[prevSeq.length - 1]].mold, job.mold);
        const c = cost[prev] + job.duration + add;
        if (c > bestC) continue;
        const s = prevSeq.concat(ids[j]);
        if (c < bestC || s.join(',') < bestS.join(',')) {
          bestC = c;
          bestS = s;
        }
      }
      cost[mask] = bestC;
      seq[mask] = bestS;
    }
    const full = size - 1;
    const res = cost[full] <= caps[si]
      ? { cost: cost[full], seq: seq[full], str: seq[full].join(',') }
      : null;
    memo.order.set(key, res);
    return res;
  }

  // Assign remaining `ids` (sorted) to shifts i..end, minimizing total cost.
  function assignDP(i, ids) {
    if (i === shiftIds.length) {
      return ids.length === 0 ? { cost: 0, str: '', blocks: [] } : null;
    }
    const key = i + '|' + ids.join(',');
    if (memo.assign.has(key)) return memo.assign.get(key);
    stats.assign += 1;
    const idSet = new Set(ids);
    const pinnedHere = pinOf[i];
    let best = null;
    if (pinnedHere.every((j) => idSet.has(j))) {
      const m = ids.length;
      const idx = new Map(ids.map((j, k) => [j, k]));
      let pinMask = 0;
      for (const j of pinnedHere) pinMask |= 1 << idx.get(j);
      let forbidMask = 0;
      for (let k = 0; k < shiftIds.length; k++) {
        if (k === i) continue;
        for (const j of pinOf[k]) if (idSet.has(j)) forbidMask |= 1 << idx.get(j);
      }
      const full = (1 << m) - 1;
      for (let sub = full; ; sub = (sub - 1) & full) {
        if ((sub & pinMask) === pinMask && (sub & forbidMask) === 0) {
          const subIds = [];
          const restIds = [];
          for (let k = 0; k < m; k++) {
            ((sub >> k) & 1 ? subIds : restIds).push(ids[k]);
          }
          const ord = bestOrder(subIds, i);
          if (ord) {
            const rest = assignDP(i + 1, restIds);
            if (rest) {
              const cand = {
                cost: ord.cost + rest.cost,
                str: shiftIds[i] + ':' + ord.str + '|' + rest.str,
                blocks: [{ shift: shiftIds[i], jobs: ord.seq, cost: ord.cost }].concat(rest.blocks)
              };
              if (!best || compareCandidate(cand, best) < 0) best = cand;
            }
          }
        }
        if (sub === 0) break;
      }
    }
    memo.assign.set(key, best);
    return best;
  }

  const result = assignDP(0, jobIds);
  if (!result) return infeasible('no-feasible-assignment');
  return {
    feasible: true,
    reason: null,
    cost: result.cost,
    plan: result.blocks,
    planStr: result.str,
    stats
  };
}

module.exports = { solve, emptyState, sortedIds, compareCandidate, setupCost, changeoverCost };

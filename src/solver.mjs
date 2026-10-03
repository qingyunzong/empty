// Exact single-machine sequencing solver.
//
// Model: all jobs run on one machine starting at time 0. Changing mold between
// consecutive jobs costs setup[prev][next] time units; the same amount is also
// charged as energy (1 energy unit per setup time unit). A sequence is feasible
// iff its total energy (sum of job energy + sum of setups) <= energyBudget.
// Objective is lexicographic (makespan, energy, total tardiness).
//
// Phase 1: subset DP g(remMask, lastMold) -> lexicographically minimal
//          (remaining time, remaining energy). Independent of due dates, so its
//          cache survives due-only edits (incremental re-solve).
// Phase 2: branch & bound enumerating every sequence that attains the optimal
//          (makespan, energy), minimizing total tardiness and collecting ALL
//          tied optima. Pruning uses optimistic setup lower bounds.
//
// status: FEASIBLE | UNSAT | UNKNOWN. UNKNOWN (node limit / size limit) is
// never reported as UNSAT.

const MAX_EXACT_JOBS = 20;

export function solveNormalized(norm, opts = {}) {
  const nodeLimit = opts.nodeLimit ?? 5_000_000;
  const jobs = norm.jobs;
  const n = jobs.length;
  const molds = norm.molds;
  const m = molds.length;
  const setup = norm.setup;
  const budget = norm.energyBudget;
  const stats = opts.stats ?? { p1Computed: 0, p1Hits: 0, p2Nodes: 0 };

  if (n > MAX_EXACT_JOBS) {
    return { status: 'UNKNOWN', reason: `instance too large for exact solver (n=${n} > ${MAX_EXACT_JOBS})`, stats };
  }
  if (m > 31) {
    return { status: 'UNKNOWN', reason: `too many molds (m=${m} > 31)`, stats };
  }

  const moldIndexOf = new Map(molds.map((name, i) => [name, i]));
  const moldIdx = jobs.map((j) => moldIndexOf.get(j.mold));
  const full = (1 << n) - 1;

  const sumWork = new Float64Array(1 << n);
  const sumEnergy = new Float64Array(1 << n);
  for (let mask = 1; mask <= full; mask++) {
    const b = mask & -mask;
    const i = 31 - Math.clz32(b);
    sumWork[mask] = sumWork[mask ^ b] + jobs[i].work;
    sumEnergy[mask] = sumEnergy[mask ^ b] + jobs[i].energy;
  }

  const minSetupTo = new Float64Array(m);
  for (let b = 0; b < m; b++) {
    let best = Infinity;
    for (let a = 0; a < m; a++) {
      if (a !== b && setup[a][b] < best) best = setup[a][b];
    }
    minSetupTo[b] = best === Infinity ? 0 : best;
  }

  // Optimistic setup lower bound for the remaining set: a remaining job pays 0
  // if its mold equals the current mold or is shared with another remaining job;
  // otherwise its mold group pays at least the cheapest incoming setup. When no
  // mold is currently loaded (last < 0), the first scheduled group pays nothing,
  // so the largest group bound is exempted.
  function setupLB(rem, last) {
    let lb = 0;
    let seen = 0;
    let dup = 0;
    let r = rem;
    while (r) {
      const b = r & -r;
      r ^= b;
      const mb = 1 << moldIdx[31 - Math.clz32(b)];
      if (seen & mb) dup |= mb;
      else seen |= mb;
    }
    let s = seen & ~dup;
    let maxGroup = 0;
    while (s) {
      const b = s & -s;
      s ^= b;
      const mj = 31 - Math.clz32(b);
      if (mj !== last) {
        lb += minSetupTo[mj];
        if (minSetupTo[mj] > maxGroup) maxGroup = minSetupTo[mj];
      }
    }
    if (last < 0) lb -= maxGroup;
    return lb;
  }

  // ---- Phase 1: min (time, energy) suffix DP, externally cacheable. ----
  const cache = opts.cache ?? new Map();
  const stride = m + 1;
  function g(rem, last) {
    if (rem === 0) return ZERO_PAIR;
    const key = rem * stride + (last + 1);
    const hit = cache.get(key);
    if (hit) {
      stats.p1Hits++;
      return hit;
    }
    stats.p1Computed++;
    let best = null;
    let r = rem;
    while (r) {
      const b = r & -r;
      r ^= b;
      const j = 31 - Math.clz32(b);
      const mj = moldIdx[j];
      const st = last < 0 || mj === last ? 0 : setup[last][mj];
      const sub = g(rem ^ b, mj);
      const candT = st + jobs[j].work + sub[0];
      const candE = st + jobs[j].energy + sub[1];
      if (best === null || candT < best[0] || (candT === best[0] && candE < best[1])) {
        best = [candT, candE];
      }
    }
    cache.set(key, best);
    return best;
  }
  const ZERO_PAIR = [0, 0];

  const root = g(full, -1);
  const bestM = root[0];
  const bestE = root[1];

  if (bestE > budget) {
    return { status: 'UNSAT', minEnergy: bestE, stats };
  }

  // ---- Phase 2: enumerate all (bestM, bestE) sequences, min tardiness, ties. ----
  const edd = jobs.map((_, i) => i).sort((a, b) => jobs[a].due - jobs[b].due || a - b);
  let bestT = Infinity;
  const ties = [];
  let aborted = false;
  let nodes = 0;
  const path = new Int32Array(n);

  function dfs(mask, last, time, energy, tard, depth) {
    if (aborted) return;
    if (++nodes > nodeLimit) {
      aborted = true;
      return;
    }
    stats.p2Nodes++;
    if (mask === full) {
      if (tard < bestT) {
        bestT = tard;
        ties.length = 0;
        ties.push(Array.from(path));
      } else if (tard === bestT) {
        ties.push(Array.from(path));
      }
      return;
    }
    const rem = full & ~mask;
    const slb = setupLB(rem, last);
    const lbT = time + sumWork[rem] + slb;
    if (lbT > bestM) return;
    const lbE = energy + sumEnergy[rem] + slb;
    if (lbT === bestM && lbE > bestE) return;
    if (lbE > budget) return;
    if (lbT === bestM && lbE === bestE && tard > bestT) return;
    for (const j of edd) {
      const bit = 1 << j;
      if (!(rem & bit)) continue;
      const mj = moldIdx[j];
      const st = last < 0 || mj === last ? 0 : setup[last][mj];
      const nt = time + st + jobs[j].work;
      path[depth] = j;
      dfs(mask | bit, mj, nt, energy + st + jobs[j].energy, tard + Math.max(0, nt - jobs[j].due), depth + 1);
    }
  }
  dfs(0, -1, 0, 0, 0, 0);

  if (aborted) {
    return { status: 'UNKNOWN', reason: `node limit exceeded (${nodeLimit})`, stats };
  }

  const schedules = ties.map((p) => p.map((j) => jobs[j].id));
  return {
    status: 'FEASIBLE',
    objective: { makespan: bestM, energy: bestE, tardiness: bestT },
    schedule: detail(ties[0]),
    schedules,
    stats,
  };

  function detail(p) {
    let t = 0;
    let last = -1;
    return p.map((j) => {
      const mj = moldIdx[j];
      const st = last < 0 || mj === last ? 0 : setup[last][mj];
      const start = t + st;
      const end = start + jobs[j].work;
      t = end;
      last = mj;
      return { job: jobs[j].id, mold: jobs[j].mold, setup: st, start, end };
    });
  }
}

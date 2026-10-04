// Exact solver: enumerates batch partitions x integer run start times with
// branch-and-bound pruning. Objective is lexicographic (makespan, peak-valley
// difference, run count). All tied optima are kept (up to maxTies).
import { EPS, validateBatch, compileCurve } from './curve.js';
import { runFeasible, runProfile, scheduleStats, maxClosedPower } from './model.js';

export class BudgetExceeded extends Error {}

export function validateConfig(config) {
  const errors = [];
  const push = (m) => errors.push({ code: 'ERR_DOMAIN', batchId: null, message: m });
  if (!config || typeof config !== 'object') {
    return [{ code: 'ERR_DOMAIN', batchId: null, message: 'config must be an object' }];
  }
  if (!Number.isFinite(config.peakLimit) || config.peakLimit < 0) push('peakLimit must be a non-negative finite number');
  if (!Number.isFinite(config.capacity) || config.capacity <= 0) push('capacity must be a positive finite number');
  if (!Number.isFinite(config.maxTempDiff) || config.maxTempDiff < 0) push('maxTempDiff must be a non-negative finite number');
  if (!Array.isArray(config.alloyGroups)) push('alloyGroups must be an array of alloy arrays');
  return errors;
}

// Lexicographic compare with float tolerance.
export function cmpObjective(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - EPS) return -1;
    if (a[i] > b[i] + EPS) return 1;
  }
  return 0;
}

function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function configHash(config) {
  return stableStringify({
    peakLimit: config.peakLimit,
    capacity: config.capacity,
    maxTempDiff: config.maxTempDiff,
    alloyGroups: config.alloyGroups ?? [],
  });
}

function batchHash(b) {
  return stableStringify({ id: b.id, alloy: b.alloy, tempBand: b.tempBand, load: b.load, curve: b.curve });
}

// Enumerate all set partitions of {0..n-1}, pruning blocks that fail isFeasibleBlock.
export function eachPartition(n, isFeasibleBlock, cb) {
  const blocks = [];
  (function rec(i) {
    if (i === n) {
      cb(blocks.map((b) => [...b]));
      return;
    }
    for (let bi = 0; bi < blocks.length; bi++) {
      blocks[bi].push(i);
      if (isFeasibleBlock(blocks[bi])) rec(i + 1);
      blocks[bi].pop();
    }
    blocks.push([i]);
    if (isFeasibleBlock(blocks[blocks.length - 1])) rec(i + 1);
    blocks.pop();
  })(0);
}

// Optimal placement (integer start times) of one partition's runs.
// Self-contained: uses only its own incumbent, so results are cacheable.
function optimizePartition(blocks, profiles, batches, config, ctx) {
  const k = blocks.length;
  // A run whose own peak exceeds the limit can never be placed.
  if (profiles.some((p) => p.peak > config.peakLimit + EPS)) {
    return { objective: null, schedules: [], truncated: false };
  }
  const order = [...Array(k).keys()].sort(
    (a, b) => profiles[b].duration - profiles[a].duration || a - b
  );
  const horizon = profiles.reduce((s, p) => s + p.duration, 0);
  const starts = new Array(k).fill(0);
  const placed = [];
  let best = null;
  let schedules = [];
  let truncated = false;

  function snapshot() {
    const runs = blocks
      .map((blk, bi) => ({ start: starts[bi], batches: blk.map((i) => batches[i].id).sort() }))
      .sort((a, b) => a.start - b.start || (a.batches[0] < b.batches[0] ? -1 : 1));
    return { runs };
  }

  function dfs(pos) {
    if (pos === k) {
      const stats = scheduleStats(placed);
      const obj = [stats.makespan, stats.max - stats.min];
      const c = best ? cmpObjective(obj, best) : -1;
      if (c < 0) {
        best = obj;
        schedules = [snapshot()];
        truncated = false;
      } else if (c === 0) {
        if (schedules.length < ctx.maxTies) schedules.push(snapshot());
        else truncated = true;
      }
      return;
    }
    const bi = order[pos];
    const prof = profiles[bi];
    let bound = best ? best[0] : horizon;
    if (ctx.bestMakespan < bound) bound = ctx.bestMakespan;
    const latest = Math.floor(bound - prof.duration + EPS);
    for (let s = 0; s <= latest; s++) {
      ctx.tick();
      starts[bi] = s;
      placed.push({ profile: prof, start: s });
      if (maxClosedPower(placed) <= config.peakLimit + EPS) dfs(pos + 1);
      placed.pop();
    }
  }
  dfs(0);
  return { objective: best, schedules, truncated };
}

// Greedy earliest-start list schedule of singleton runs: a cheap feasible
// makespan upper bound used to prune the exact search.
function greedyMakespanBound(batches, config) {
  const placed = [];
  for (let i = 0; i < batches.length; i++) {
    const profile = runProfile([i], batches);
    let s = 0;
    for (;;) {
      placed.push({ profile, start: s });
      if (maxClosedPower(placed) <= config.peakLimit + EPS) break;
      placed.pop();
      s++;
    }
  }
  return scheduleStats(placed).makespan;
}

// Minimum peak power under which the batch set is schedulable at all
// (sequential placement never exceeds the max run peak, so this is exact).
export function minPeak(subBatches, config) {
  let best = Infinity;
  eachPartition(
    subBatches.length,
    (blk) => runFeasible(blk, subBatches, config),
    (blocks) => {
      let peak = 0;
      for (const blk of blocks) peak = Math.max(peak, runProfile(blk, subBatches).peak);
      if (peak < best) best = peak;
    }
  );
  return best;
}

export function feasibleQuick(subBatches, config) {
  for (const b of subBatches) if (b.load > config.capacity + EPS) return false;
  return minPeak(subBatches, config) <= config.peakLimit + EPS;
}

// Subset-minimal infeasible core: removing any one batch from `subset` restores
// feasibility, and (when load is not the blocker) relaxing the peak limit to
// `relaxedPeak` also restores feasibility.
export function unsatCertificate(batches, config) {
  let core = batches.map((_, i) => i);
  const feas = (idxs) => feasibleQuick(idxs.map((i) => batches[i]), config);
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of [...core]) {
      const rest = core.filter((j) => j !== i);
      if (!feas(rest)) {
        core = rest;
        changed = true;
      }
    }
  }
  const removal = {};
  for (const i of core) {
    removal[batches[i].id] = feas(core.filter((j) => j !== i)) ? 'FEASIBLE' : 'INFEASIBLE';
  }
  const sub = core.map((i) => batches[i]);
  const loadOk = sub.every((b) => b.load <= config.capacity + EPS);
  return {
    subset: core.map((i) => batches[i].id),
    removal,
    relaxedPeak: loadOk ? minPeak(sub, config) : null,
  };
}

export function solveSchedule(batchList, config, opts = {}) {
  const configErrors = validateConfig(config);
  if (configErrors.length) return { status: 'ERROR', errors: configErrors };

  const batches = batchList.map((b) => (b && typeof b === 'object' ? { ...b } : b));
  const errors = [];
  for (const b of batches) {
    const errs = validateBatch(b);
    if (errs.length) errors.push(...errs);
    else b.compiled = compileCurve(b.curve);
  }
  if (errors.length) return { status: 'ERROR', errors };

  if (!feasibleQuick(batches, config)) {
    return { status: 'UNSAT', certificate: unsatCertificate(batches, config) };
  }

  const ctx = {
    nodes: 0,
    nodeBudget: opts.nodeBudget ?? Infinity,
    maxTies: opts.maxTies ?? 10000,
    cacheHits: 0,
    tick() {
      this.nodes++;
      if (this.nodes > this.nodeBudget) throw new BudgetExceeded();
    },
  };
  const cache = opts.cache ?? null;
  const cfgHash = configHash(config);
  const hashes = batches.map(batchHash);
  const blockKey = (blk) => blk.map((i) => hashes[i]).sort().join(',');
  // Block-level incremental cache: run feasibility and run power profiles
  // depend only on the block's batch definitions (+ config), so an edit to
  // one batch only invalidates blocks containing that batch.
  const runFeasibleCached = (blk) => {
    if (!cache) return runFeasible(blk, batches, config);
    const key = 'F|' + cfgHash + '|' + blockKey(blk);
    if (cache.has(key)) {
      ctx.cacheHits++;
      return cache.get(key);
    }
    const v = runFeasible(blk, batches, config);
    cache.set(key, v);
    return v;
  };
  const runProfileCached = (blk) => {
    if (!cache) return runProfile(blk, batches);
    const key = 'P|' + blockKey(blk);
    if (cache.has(key)) {
      ctx.cacheHits++;
      return cache.get(key);
    }
    const v = runProfile(blk, batches);
    cache.set(key, v);
    return v;
  };
  let best = null;
  let ties = [];
  let truncated = false;
  let partitions = 0;

  try {
    const ctx2 = Object.assign(ctx, { bestMakespan: greedyMakespanBound(batches, config) });
    const allPartitions = [];
    eachPartition(
      batches.length,
      (blk) => runFeasibleCached(blk),
      (blocks) => allPartitions.push(blocks)
    );
    // Fewer blocks first: co-fired partitions tend to yield good makespans
    // early, tightening the shared bound for the rest of the search.
    allPartitions.sort((a, b) => a.length - b.length);
    for (const blocks of allPartitions) {
        partitions++;
        const profiles = blocks.map(runProfileCached);
        const res = optimizePartition(blocks, profiles, batches, config, ctx2);
        if (!res.objective) continue; // partition not placeable under the peak limit
        const obj = [...res.objective, blocks.length];
        const c = best ? cmpObjective(obj, best) : -1;
        if (c < 0) {
          best = obj;
          ties = res.schedules;
          truncated = res.truncated;
          if (obj[0] < ctx2.bestMakespan) ctx2.bestMakespan = obj[0];
        } else if (c === 0) {
          ties = ties.concat(res.schedules);
          truncated = truncated || res.truncated;
        }
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      return {
        status: 'UNKNOWN',
        incumbent: best ? { makespan: best[0], peakValley: best[1], runs: best[2] } : null,
        stats: { nodes: ctx.nodes, partitions },
      };
    }
    throw e;
  }

  return {
    status: 'OPTIMAL',
    objective: { makespan: best[0], peakValley: best[1], runs: best[2] },
    schedules: ties,
    tiesTruncated: truncated,
    stats: { nodes: ctx.nodes, partitions, cacheHits: ctx.cacheHits },
  };
}

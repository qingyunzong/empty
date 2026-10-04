import { SchedulerError, ERR_DOMAIN } from './errors.js';
import { prepareBatch, runCompatible, makeRun } from './model.js';

const EPS = 1e-9;

// 目标字典序：完成时刻 makespan -> 峰谷差 peakValley -> 炉次数 runCount。
function keyCompare(a, b, tol) {
  if (a.makespan < b.makespan - tol) return -1;
  if (a.makespan > b.makespan + tol) return 1;
  if (a.peakValley < b.peakValley - tol) return -1;
  if (a.peakValley > b.peakValley + tol) return 1;
  return a.runCount - b.runCount;
}

function normalizeConfig(config) {
  const cfg = {
    peak: Infinity,
    capacity: Infinity,
    deltaMax: Infinity,
    grid: 1,
    nodeLimit: 200000,
    maxSolutions: 50,
    tol: EPS,
    ...config,
  };
  for (const k of ['peak', 'capacity', 'deltaMax']) {
    if (Number.isNaN(cfg[k])) throw new SchedulerError(ERR_DOMAIN, `配置 ${k} 为 NaN`);
  }
  if (!(cfg.grid > 0)) throw new SchedulerError(ERR_DOMAIN, `配置 grid 必须为正 (${cfg.grid})`);
  return cfg;
}

function* combinations(arr, k) {
  const idx = [];
  function* rec(start) {
    if (idx.length === k) {
      yield idx.map((i) => arr[i]);
      return;
    }
    for (let i = start; i <= arr.length - (k - idx.length); i++) {
      idx.push(i);
      yield* rec(i + 1);
      idx.pop();
    }
  }
  yield* rec(0);
}

// 精确离散时间枚举：集合划分（受限增长串）x 炉次开炉时刻 DFS。
// mode: 'lex' 收集全部并列最优；'first' 找到即停；'minPeak' 求最小可行峰值。
function enumerate(batches, cfg, budget, cache, opts) {
  const tol = cfg.tol;
  const state = { found: false, key: null, list: [], complete: true, minPeak: Infinity };
  const n = batches.length;
  if (n === 0) {
    state.found = true;
    state.key = { makespan: 0, peakValley: 0, runCount: 0 };
    state.minPeak = 0;
    if (opts.mode === 'lex') {
      state.list.push({ runs: [], makespan: 0, peakValley: 0, runCount: 0, peakUsage: 0 });
    }
    return state;
  }
  const sig = (idxs) => idxs.map((i) => `${batches[i].id}#${batches[i]._version ?? 0}`).sort().join('|');
  const compat = (idxs) => {
    const k = sig(idxs);
    let v = cache.runCompat.get(k);
    if (v === undefined) {
      v = runCompatible(idxs.map((i) => batches[i]), cfg);
      if (cache.runCompat.size > 50000) cache.runCompat.clear();
      cache.runCompat.set(k, v);
    }
    return v;
  };
  const bump = () => {
    budget.used += 1;
    if (budget.used > budget.limit) budget.exceeded = true;
  };
  const ctrl = { stop: false };

  const runsIdx = [];
  function recPartition(i) {
    if (budget.exceeded || ctrl.stop) return;
    if (i === n) {
      placeAll();
      return;
    }
    for (const run of runsIdx) {
      if (compat([...run, i])) {
        run.push(i);
        bump();
        recPartition(i + 1);
        run.pop();
        if (budget.exceeded || ctrl.stop) return;
      }
    }
    if (compat([i])) {
      runsIdx.push([i]);
      bump();
      recPartition(i + 1);
      runsIdx.pop();
    }
  }

  function placeAll() {
    bump();
    if (budget.exceeded) return;
    const runObjs = runsIdx.map((idxs) => makeRun(idxs.map((i) => batches[i]), cfg.grid));
    if (runObjs.some((r) => r.peak > cfg.peak + tol)) return;
    const H = runObjs.reduce((s, r) => s + r.duration, 0);
    const usage = new Float64Array(Math.ceil(H / cfg.grid - tol) + 2);
    const starts = new Array(runObjs.length);
    const order = runObjs.map((_, k) => k).sort((a, b) => runObjs[b].duration - runObjs[a].duration);
    const makespanCap = () => (opts.mode === 'lex' && state.key ? state.key.makespan : Infinity);

    function leaf(makespan) {
      bump();
      const slotsUsed = Math.max(1, Math.ceil(makespan / cfg.grid - tol));
      let hi = -Infinity;
      let lo = Infinity;
      for (let t = 0; t < slotsUsed; t++) {
        const u = usage[t];
        if (u > hi) hi = u;
        if (u < lo) lo = u;
      }
      if (!Number.isFinite(hi)) {
        hi = 0;
        lo = 0;
      }
      state.found = true;
      if (opts.mode === 'first') {
        ctrl.stop = true;
        return;
      }
      if (opts.mode === 'minPeak') {
        if (hi < state.minPeak) state.minPeak = hi;
        return;
      }
      const peakValley = hi - lo;
      const key = { makespan, peakValley, runCount: runsIdx.length };
      const runs = runsIdx.map((idxs, k) => ({
        batchIds: idxs.map((i) => batches[i].id),
        start: starts[k],
        end: starts[k] + runObjs[k].duration,
      }));
      runs.sort((a, b) => a.start - b.start || a.batchIds.join(',').localeCompare(b.batchIds.join(',')));
      const sched = { runs, makespan, peakValley, runCount: runsIdx.length, peakUsage: hi };
      const cmp = state.key ? keyCompare(key, state.key, tol) : -1;
      if (cmp < 0) {
        state.key = key;
        state.list = [sched];
        state.complete = true;
      } else if (cmp === 0) {
        if (state.list.length < opts.maxSolutions) state.list.push(sched);
        else state.complete = false;
      }
    }

    function rec(k, curMakespan) {
      if (budget.exceeded || ctrl.stop) return;
      if (curMakespan > makespanCap() + tol) return;
      if (k === order.length) {
        leaf(curMakespan);
        return;
      }
      const ri = order[k];
      const r = runObjs[ri];
      const maxStart = Math.min(H, makespanCap()) - r.duration;
      for (let s = 0; s <= maxStart + tol; s += cfg.grid) {
        bump();
        if (budget.exceeded) return;
        const si = Math.round(s / cfg.grid);
        let ok = true;
        for (let j = 0; j < r.profile.length; j++) {
          if (usage[si + j] + r.profile[j] > cfg.peak + tol) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        for (let j = 0; j < r.profile.length; j++) usage[si + j] += r.profile[j];
        starts[ri] = s;
        rec(k + 1, Math.max(curMakespan, s + r.duration));
        for (let j = 0; j < r.profile.length; j++) usage[si + j] -= r.profile[j];
        if (budget.exceeded || ctrl.stop) return;
      }
    }
    rec(0, 0);
  }

  recPartition(0);
  return state;
}

function minPeakFor(subset, cfg, budget, cache) {
  const st = enumerate(subset, { ...cfg, peak: Infinity }, budget, cache, { mode: 'minPeak' });
  return st.minPeak;
}

// UNSAT 证书：按子集大小递增找到最小（按包含关系极小）不可行子集，
// 因此删除其中任意一批即可满足；同时给出放宽峰值后的可行阈值。
function findCertificate(batches, cfg, budget, cache) {
  const n = batches.length;
  const sigOf = (list) => list.map((b) => `${b.id}#${b._version ?? 0}`).sort().join('|');
  const isFeasible = (list) => {
    const k = sigOf(list);
    let v = cache.feas.get(k);
    if (v === undefined) {
      const st = enumerate(list, cfg, budget, cache, { mode: 'first' });
      if (budget.exceeded) return undefined;
      v = st.found;
      if (cache.feas.size > 50000) cache.feas.clear();
      cache.feas.set(k, v);
    }
    return v;
  };
  for (let k = 1; k <= n; k++) {
    for (const subset of combinations(batches, k)) {
      if (budget.exceeded) return null;
      const feas = isFeasible(subset);
      if (feas === undefined) return null;
      if (!feas) {
        const relax = minPeakFor(subset, cfg, budget, cache);
        if (budget.exceeded) return null;
        const ids = subset.map((b) => b.id);
        return {
          subset: ids,
          relaxPeakTo: relax,
          deletionSuffices: true,
          message: `子集 {${ids.join(', ')}} 不可行：删除其中任意一批即可满足；或将峰值放宽至 ${relax}`,
        };
      }
    }
  }
  return null;
}

// 主入口。返回 { status: 'OPTIMAL' | 'UNSAT' | 'UNKNOWN', ... }。
export function solve(rawBatches, config = {}, cache = null) {
  const cfg = normalizeConfig(config);
  const batches = rawBatches.map(prepareBatch);
  const budget = { used: 0, limit: cfg.nodeLimit, exceeded: false, stop: false };
  const ctx = cache ?? { runCompat: new Map(), feas: new Map() };
  const best = enumerate(batches, cfg, budget, ctx, { mode: 'lex', maxSolutions: cfg.maxSolutions });
  if (budget.exceeded) {
    return { status: 'UNKNOWN', reason: `搜索超出节点预算 ${cfg.nodeLimit}`, nodes: budget.used };
  }
  if (best.found) {
    return {
      status: 'OPTIMAL',
      objective: { ...best.key },
      schedules: best.list,
      tiesComplete: best.complete,
      nodes: budget.used,
    };
  }
  const certificate = findCertificate(batches, cfg, budget, ctx);
  if (budget.exceeded || certificate === null) {
    return { status: 'UNKNOWN', reason: '不可行证书生成超出节点预算', nodes: budget.used };
  }
  return { status: 'UNSAT', certificate, nodes: budget.used };
}

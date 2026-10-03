'use strict';
const { overlaps } = require('./model');

const EXACT_THRESHOLD = 16;

function cmpScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function makeCtx(model, affectedSet, pinned) {
  const contractsByStation = new Map();
  for (const c of model.contracts) {
    if (!contractsByStation.has(c.station)) contractsByStation.set(c.station, []);
    contractsByStation.get(c.station).push(c);
  }
  return {
    model,
    affectedSet,
    pinned,
    contractsOf: (st) => contractsByStation.get(st) || [],
    batteryOf: (st) => model.stations.get(st).battery,
  };
}

function canAdd(w, chosen, ctx) {
  const all = ctx.pinned.concat(chosen);
  let energy = w.energy;
  for (const o of all) {
    if (o.station === w.station && o.id === w.id) return false;
    if (o.link === w.link && overlaps(o, w)) return false;
    if (o.station === w.station) energy += o.energy;
  }
  if (energy > ctx.batteryOf(w.station)) return false;
  for (const c of ctx.contractsOf(w.station)) {
    if (c.period === null || c.quota === null) continue;
    const p = Math.floor(w.start / c.period);
    let count = 0;
    for (const o of all) {
      if (o.station === w.station && Math.floor(o.start / c.period) === p) count++;
    }
    if (count >= c.quota) return false;
  }
  return true;
}

// Lexicographic objective: satisfied contracts, stations at floor, -energy, -count.
function scorePlan(chosen, ctx) {
  const all = ctx.pinned.concat(chosen);
  let satisfied = 0;
  for (const c of ctx.model.contracts) {
    if (!ctx.affectedSet.has(c.station)) continue;
    let n = 0;
    for (const o of all) if (o.station === c.station) n++;
    if (n >= c.min) satisfied++;
  }
  let floored = 0;
  for (const stId of ctx.affectedSet) {
    if (ctx.contractsOf(stId).length === 0) continue;
    let n = 0;
    for (const o of all) if (o.station === stId) n++;
    if (n >= ctx.model.floor) floored++;
  }
  let energy = 0;
  for (const w of chosen) energy += w.energy;
  return [satisfied, floored, -energy, -chosen.length];
}

function canonicalOrder(wins) {
  return wins
    .slice()
    .sort(
      (a, b) => a.station.localeCompare(b.station) || a.start - b.start || a.id.localeCompare(b.id)
    );
}

// Exact search over subsets. Include-first DFS with strict improvement keeps the
// first optimum found, i.e. ties prefer including canonically earlier windows
// (station id, then start time, then window id).
function exactSolve(candidates, ctx) {
  const free = canonicalOrder(candidates.filter((w) => !w.locked));
  const chosen = candidates.filter((w) => w.locked);
  let best = null;
  let bestScore = null;
  const dfs = (i) => {
    if (i === free.length) {
      const s = scorePlan(chosen, ctx);
      if (bestScore === null || cmpScore(s, bestScore) > 0) {
        bestScore = s;
        best = chosen.slice();
      }
      return;
    }
    const w = free[i];
    if (canAdd(w, chosen, ctx)) {
      chosen.push(w);
      dfs(i + 1);
      chosen.pop();
    }
    dfs(i + 1);
  };
  dfs(0);
  return best;
}

// Greedy for large candidate sets: starvation floor first, then max-deficit-first.
// Ties: deficit descending, station id ascending, window start ascending.
function greedySolve(candidates, ctx) {
  const chosen = candidates.filter((w) => w.locked);
  const pool = candidates.filter((w) => !w.locked);
  const countOf = (stId) => {
    let n = 0;
    for (const o of ctx.pinned) if (o.station === stId) n++;
    for (const o of chosen) if (o.station === stId) n++;
    return n;
  };
  const deficitOf = (stId) => {
    let d = 0;
    for (const c of ctx.contractsOf(stId)) d += Math.max(0, c.min - countOf(stId));
    return d;
  };
  const bestWindow = (stId) => {
    let bestW = null;
    for (const w of pool) {
      if (w.station !== stId) continue;
      if (!canAdd(w, chosen, ctx)) continue;
      if (bestW === null || w.start < bestW.start || (w.start === bestW.start && w.id < bestW.id)) {
        bestW = w;
      }
    }
    return bestW;
  };
  const floorSkip = new Set();
  for (;;) {
    const needy = [];
    for (const stId of ctx.affectedSet) {
      if (floorSkip.has(stId) || ctx.contractsOf(stId).length === 0) continue;
      if (countOf(stId) < ctx.model.floor) needy.push(stId);
    }
    if (needy.length === 0) break;
    needy.sort((a, b) => deficitOf(b) - deficitOf(a) || a.localeCompare(b));
    const stId = needy[0];
    const w = bestWindow(stId);
    if (!w) {
      floorSkip.add(stId);
      continue;
    }
    chosen.push(w);
  }
  const blocked = new Set();
  for (;;) {
    const open = [];
    for (const stId of ctx.affectedSet) {
      for (const c of ctx.contractsOf(stId)) {
        if (!blocked.has(c.id) && countOf(stId) < c.min) open.push(c);
      }
    }
    if (open.length === 0) break;
    open.sort((a, b) => {
      const da = a.min - countOf(a.station);
      const db = b.min - countOf(b.station);
      return db - da || a.station.localeCompare(b.station) || a.id.localeCompare(b.id);
    });
    const c = open[0];
    const w = bestWindow(c.station);
    if (!w) {
      blocked.add(c.id);
      continue;
    }
    chosen.push(w);
  }
  return chosen;
}

function solve(candidates, ctx) {
  if (candidates.length <= EXACT_THRESHOLD) return exactSolve(candidates, ctx);
  return greedySolve(candidates, ctx);
}

// Max windows a station could schedule alone (own overlaps, optional battery,
// optional per-contract period quota). Used to explain unmet contracts.
function soloCapacity(station, windows, contract, useBattery) {
  const wins = windows.slice().sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const chosen = [];
  const ok = (w) => {
    for (const o of chosen) if (overlaps(o, w)) return false;
    if (useBattery) {
      let e = w.energy;
      for (const o of chosen) e += o.energy;
      if (e > station.battery) return false;
    }
    if (contract && contract.period !== null && contract.quota !== null) {
      const p = Math.floor(w.start / contract.period);
      let n = 0;
      for (const o of chosen) if (Math.floor(o.start / contract.period) === p) n++;
      if (n >= contract.quota) return false;
    }
    return true;
  };
  if (wins.length <= 16) {
    let best = 0;
    const dfs = (i) => {
      if (chosen.length + (wins.length - i) <= best) return;
      if (i === wins.length) {
        best = chosen.length;
        return;
      }
      const w = wins[i];
      if (ok(w)) {
        chosen.push(w);
        dfs(i + 1);
        chosen.pop();
      }
      dfs(i + 1);
    };
    dfs(0);
    return best;
  }
  let n = 0;
  for (const w of wins) {
    if (ok(w)) {
      chosen.push(w);
      n++;
    }
  }
  return n;
}

module.exports = {
  EXACT_THRESHOLD,
  cmpScore,
  makeCtx,
  canAdd,
  scorePlan,
  canonicalOrder,
  exactSolve,
  greedySolve,
  solve,
  soloCapacity,
};

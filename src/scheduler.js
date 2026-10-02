import {cmpStr} from './util.js';

export const EXACT_THRESHOLD = 11;

function cmpCand(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

class Ctx {
  constructor(stations, contracts, fixed) {
    this.stationMap = new Map();
    for (const s of stations) {
      const windows = [...s.windows].sort(
        (a, b) => a.start - b.start || a.end - b.end || cmpStr(a.id, b.id));
      this.stationMap.set(s.id, {...s, windows});
    }
    this.contracts = [...contracts].sort((a, b) => cmpStr(a.id, b.id));
    this.byStation = new Map();
    for (const c of this.contracts) {
      const list = this.byStation.get(c.station) || [];
      list.push(c);
      this.byStation.set(c.station, list);
    }
    this.usedWindows = new Set();
    this.batteryUsed = new Map();
    this.linkBusy = new Map();
    this.quotaUsed = new Map();
    this.counts = new Map();
    this.entries = [];
    for (const e of fixed) this.placeFixed(e);
  }

  served(id) {
    return this.counts.get(id) || 0;
  }

  placeFixed(e) {
    const st = this.stationMap.get(e.station);
    this.usedWindows.add(e.station + '/' + e.window);
    this.batteryUsed.set(e.station, (this.batteryUsed.get(e.station) || 0) + (e.cost || 0));
    if (st) {
      const arr = this.linkBusy.get(st.link) || [];
      arr.push([e.start, e.end]);
      this.linkBusy.set(st.link, arr);
    }
    if (e.contract) {
      this.counts.set(e.contract, this.served(e.contract) + 1);
      const c = this.contracts.find((x) => x.id === e.contract);
      if (c) {
        const k = e.contract + '@' + Math.floor(e.start / c.period);
        this.quotaUsed.set(k, (this.quotaUsed.get(k) || 0) + 1);
      }
    }
    this.entries.push({...e});
  }

  canPlace(stationId, w, contract) {
    const st = this.stationMap.get(stationId);
    if (!st) return false;
    if (this.usedWindows.has(stationId + '/' + w.id)) return false;
    if ((this.batteryUsed.get(stationId) || 0) + w.cost > st.battery) return false;
    const busy = this.linkBusy.get(st.link) || [];
    for (const [s, e] of busy) {
      if (w.start < e && s < w.end) return false;
    }
    const k = contract.id + '@' + Math.floor(w.start / contract.period);
    if ((this.quotaUsed.get(k) || 0) >= contract.quota) return false;
    return true;
  }

  place(stationId, w, contract) {
    const st = this.stationMap.get(stationId);
    this.usedWindows.add(stationId + '/' + w.id);
    this.batteryUsed.set(stationId, (this.batteryUsed.get(stationId) || 0) + w.cost);
    const busy = this.linkBusy.get(st.link) || [];
    busy.push([w.start, w.end]);
    this.linkBusy.set(st.link, busy);
    const k = contract.id + '@' + Math.floor(w.start / contract.period);
    this.quotaUsed.set(k, (this.quotaUsed.get(k) || 0) + 1);
    this.counts.set(contract.id, this.served(contract.id) + 1);
    const entry = {
      station: stationId, window: w.id, start: w.start, end: w.end,
      cost: w.cost, contract: contract.id, locked: !!w.locked,
    };
    this.entries.push(entry);
    return entry;
  }

  unplace(stationId, w, contract) {
    const st = this.stationMap.get(stationId);
    this.usedWindows.delete(stationId + '/' + w.id);
    this.batteryUsed.set(stationId, this.batteryUsed.get(stationId) - w.cost);
    const busy = this.linkBusy.get(st.link);
    const i = busy.findIndex(([s, e]) => s === w.start && e === w.end);
    busy.splice(i, 1);
    const k = contract.id + '@' + Math.floor(w.start / contract.period);
    this.quotaUsed.set(k, this.quotaUsed.get(k) - 1);
    this.counts.set(contract.id, this.served(contract.id) - 1);
    this.entries.pop();
  }

  earliestFeasible(contract) {
    const st = this.stationMap.get(contract.station);
    if (!st) return null;
    for (const w of st.windows) {
      if (this.canPlace(contract.station, w, contract)) return w;
    }
    return null;
  }
}

function exactSolve(ctx) {
  const items = [];
  const stationIds = [...ctx.stationMap.keys()].sort(cmpStr);
  for (const sid of stationIds) {
    const cs = ctx.byStation.get(sid) || [];
    if (cs.length === 0) continue;
    for (const w of ctx.stationMap.get(sid).windows) items.push({sid, w, cs});
  }
  let bestKey = null;
  let bestEntries = [];
  const key = () => {
    let floorSat = 0;
    let sat = 0;
    let minSum = 0;
    for (const c of ctx.contracts) {
      const n = ctx.served(c.id);
      if (n >= c.floor) floorSat++;
      if (n >= c.min) sat++;
      minSum += Math.min(n, c.min);
    }
    return [floorSat, sat, minSum, -ctx.entries.length];
  };
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  };
  const dfs = (i) => {
    if (i === items.length) {
      const k = key();
      if (!bestKey || better(k, bestKey)) {
        bestKey = k;
        bestEntries = ctx.entries.slice();
      }
      return;
    }
    const {sid, w, cs} = items[i];
    for (const c of cs) {
      if (ctx.canPlace(sid, w, c)) {
        ctx.place(sid, w, c);
        dfs(i + 1);
        ctx.unplace(sid, w, c);
      }
    }
    dfs(i + 1);
  };
  dfs(0);
  return bestEntries;
}

function greedySolve(ctx) {
  // Floor phase: round-robin so every contract reaches its floor first (anti-starvation).
  for (;;) {
    let progressed = false;
    for (const c of ctx.contracts) {
      if (ctx.served(c.id) >= c.floor) continue;
      const w = ctx.earliestFeasible(c);
      if (w) {
        ctx.place(c.station, w, c);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  // Main phase: max-deficit-first; ties by (station id, window start).
  for (;;) {
    let best = null;
    for (const c of ctx.contracts) {
      const deficit = c.min - ctx.served(c.id);
      if (deficit <= 0) continue;
      const w = ctx.earliestFeasible(c);
      if (!w) continue;
      const cand = [-deficit, c.station, w.start, c.id];
      if (!best || cmpCand(cand, best.cand) < 0) best = {c, w, cand};
    }
    if (!best) break;
    ctx.place(best.c.station, best.w, best.c);
  }
  return ctx.entries.slice();
}

export function computeSchedule({stations, contracts, fixed = []}) {
  const normStations = stations.map((s) => ({link: 'default', battery: 0, ...s}));
  const normContracts = contracts.map((c) => ({floor: 0, ...c}));
  const ctx = new Ctx(normStations, normContracts, fixed);
  const totalWindows = normStations.reduce((n, s) => n + s.windows.length, 0);
  const entries = totalWindows <= EXACT_THRESHOLD ? exactSolve(ctx) : greedySolve(ctx);
  const counts = new Map();
  for (const e of entries) {
    if (e.contract) counts.set(e.contract, (counts.get(e.contract) || 0) + 1);
  }
  return {entries, counts};
}

export function diagnoseUnmet(stations, contracts, counts) {
  const unmet = [];
  for (const c of contracts) {
    const served = counts.get(c.id) || 0;
    if (served >= c.min) continue;
    unmet.push({contract: c.id, served, min: c.min, reason: reasonFor(c, stations)});
  }
  return unmet;
}

function reasonFor(c, stations) {
  const st = stations.find((s) => s.id === c.station);
  if (!st) return 'no-station';
  const horizonEnd = st.windows.reduce((m, w) => Math.max(m, w.end), 0);
  const periods = horizonEnd > 0 ? Math.ceil(horizonEnd / c.period) : 0;
  if (c.quota * periods < c.min) return 'quota-cap';
  if (st.windows.length < c.min) return 'insufficient-windows';
  const alone = computeSchedule({stations: [st], contracts: [{...c, floor: 0}], fixed: []});
  if ((alone.counts.get(c.id) || 0) >= c.min) return 'mutex-contention';
  const costs = st.windows.map((w) => w.cost).sort((a, b) => a - b);
  let need = 0;
  for (let i = 0; i < Math.min(c.min, costs.length); i++) need += costs[i];
  if (need > st.battery) return 'battery';
  return 'insufficient-windows';
}

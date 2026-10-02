import {CalError} from './errors.js';
import {computeSchedule, diagnoseUnmet} from './scheduler.js';
import {leafHash, merkleRoot} from './merkle.js';
import {overlaps, sha256hex, stable, cmpStr} from './util.js';

export function validateScenario(sc) {
  if (!sc || typeof sc !== 'object') {
    throw new CalError('bad-scenario', 'scenario must be an object', 2);
  }
  const {stations, contracts} = sc;
  if (!Array.isArray(stations) || !Array.isArray(contracts)) {
    throw new CalError('bad-scenario', 'stations and contracts arrays are required', 2);
  }
  const ids = new Set();
  for (const s of stations) {
    if (!s.id || ids.has(s.id)) {
      throw new CalError('bad-scenario', 'duplicate or missing station id', 2);
    }
    ids.add(s.id);
    if (typeof s.battery !== 'number' || s.battery < 0) {
      throw new CalError('battery-negative', `station ${s.id} has negative battery`, 6);
    }
    if (!Array.isArray(s.windows)) {
      throw new CalError('bad-scenario', `station ${s.id} windows must be an array`, 2);
    }
    const wids = new Set();
    for (const w of s.windows) {
      if (!w.id || wids.has(w.id)) {
        throw new CalError('bad-scenario', `duplicate or missing window id on ${s.id}`, 2);
      }
      wids.add(w.id);
      if (!(w.start < w.end)) {
        throw new CalError('bad-window', `window ${w.id} has start >= end`, 2);
      }
      if (!(w.cost >= 0)) {
        throw new CalError('battery-negative', `window ${w.id} has negative cost`, 6);
      }
    }
  }
  const cids = new Set();
  for (const c of contracts) {
    if (!c.id || cids.has(c.id)) {
      throw new CalError('bad-scenario', 'duplicate or missing contract id', 2);
    }
    cids.add(c.id);
    if (!ids.has(c.station)) {
      throw new CalError('bad-scenario', `contract ${c.id} references unknown station`, 2);
    }
    if (!(c.min >= 0) || !(c.period > 0) || !(c.quota >= 1) || (c.floor || 0) < 0) {
      throw new CalError('bad-scenario', `contract ${c.id} has invalid min/floor/period/quota`, 2);
    }
  }
  const pre = sc.preassigned || [];
  const byLink = new Map();
  const energy = new Map();
  for (const e of pre) {
    const st = stations.find((s) => s.id === e.station);
    if (!st) throw new CalError('bad-scenario', `preassigned unknown station ${e.station}`, 2);
    const w = st.windows.find((x) => x.id === e.window);
    if (!w) throw new CalError('bad-scenario', `preassigned unknown window ${e.window}`, 2);
    const c = contracts.find((x) => x.id === e.contract);
    if (!c || c.station !== e.station) {
      throw new CalError('bad-scenario', `preassigned unknown contract ${e.contract}`, 2);
    }
    const link = st.link || 'default';
    const arr = byLink.get(link) || [];
    for (const [s2, e2] of arr) {
      if (overlaps(w.start, w.end, s2, e2)) {
        throw new CalError('mutex-overlap',
          `preassigned windows overlap on mutually exclusive link ${link}`, 6);
      }
    }
    arr.push([w.start, w.end]);
    byLink.set(link, arr);
    energy.set(st.id, (energy.get(st.id) || 0) + w.cost);
  }
  for (const [sid, used] of energy) {
    const st = stations.find((s) => s.id === sid);
    if (used > st.battery) {
      throw new CalError('battery-negative',
        `preassigned energy ${used} exceeds battery ${st.battery} on ${sid}`, 6);
    }
  }
}

export function effectiveWindows(state, sid) {
  const st = state.scenario.stations.find((s) => s.id === sid);
  const closed = new Set((state.closed && state.closed[sid]) || []);
  const added = (state.added && state.added[sid]) || [];
  let wins = [...st.windows, ...added].filter((w) => !closed.has(w.id));
  for (const f of state.failures) {
    if (f.restored || f.station !== sid) continue;
    wins = wins.filter((w) => !overlaps(w.start, w.end, f.from, f.to));
  }
  return wins;
}

function finalizePlan(state, entries) {
  const sorted = [...entries].sort(
    (a, b) => cmpStr(a.station, b.station) || a.start - b.start || cmpStr(a.window, b.window));
  const counts = new Map();
  for (const e of sorted) {
    if (e.contract) counts.set(e.contract, (counts.get(e.contract) || 0) + 1);
  }
  const stations = state.scenario.stations.map((s) => ({...s, windows: effectiveWindows(state, s.id)}));
  const contracts = state.scenario.contracts.map((c) => ({floor: 0, ...c}));
  const served = {};
  for (const c of contracts) served[c.id] = counts.get(c.id) || 0;
  const unmet = diagnoseUnmet(stations, contracts, counts);
  const stationHashes = {};
  for (const s of state.scenario.stations) {
    stationHashes[s.id] = sha256hex(stable(sorted.filter((e) => e.station === s.id)));
  }
  const leaves = sorted.map(leafHash);
  return {
    entries: sorted,
    served,
    unmet,
    stationHashes,
    merkle: {algorithm: 'sha256', leaves: leaves.length, root: merkleRoot(leaves)},
  };
}

export function computePlan(state, {affected = null, interval = null, extraFixed = []} = {}) {
  const current = state.plan ? state.plan.entries : [];
  const fixed = [];
  for (const e of current) {
    if (e.locked) {
      fixed.push(e);
      continue;
    }
    if (interval && e.station === interval.station) {
      if (!overlaps(e.start, e.end, interval.from, interval.to)) fixed.push(e);
      continue;
    }
    if (affected === null) continue;
    if (!affected.has(e.station)) fixed.push(e);
  }
  fixed.push(...extraFixed);
  const stations = state.scenario.stations.map((s) => {
    let wins = effectiveWindows(state, s.id);
    if (affected !== null && !affected.has(s.id)) wins = [];
    if (interval) {
      if (s.id !== interval.station) wins = [];
      else wins = wins.filter((w) => overlaps(w.start, w.end, interval.from, interval.to));
    }
    return {...s, windows: wins};
  });
  const result = computeSchedule({stations, contracts: state.scenario.contracts, fixed});
  return finalizePlan(state, result.entries);
}

export function initialState(scenario, seq) {
  validateScenario(scenario);
  const state = {
    version: 1,
    seq,
    scenario: {stations: scenario.stations, contracts: scenario.contracts},
    closed: {},
    added: {},
    failures: [],
    revocations: [],
    plan: null,
  };
  const locked = (scenario.preassigned || []).map((e) => {
    const st = scenario.stations.find((s) => s.id === e.station);
    const w = st.windows.find((x) => x.id === e.window);
    return {
      station: e.station, window: e.window, start: w.start, end: w.end,
      cost: w.cost, contract: e.contract, locked: true,
    };
  });
  state.plan = computePlan(state, {extraFixed: locked});
  return state;
}

function checkLockedFeasible(state) {
  const locked = state.plan.entries.filter((e) => e.locked);
  const byLink = new Map();
  const energy = new Map();
  for (const e of locked) {
    const st = state.scenario.stations.find((s) => s.id === e.station);
    const link = (st && st.link) || 'default';
    const arr = byLink.get(link) || [];
    for (const [s2, e2] of arr) {
      if (overlaps(e.start, e.end, s2, e2)) {
        throw new CalError('mutex-overlap', `locked windows overlap on link ${link}`, 6);
      }
    }
    arr.push([e.start, e.end]);
    byLink.set(link, arr);
    energy.set(e.station, (energy.get(e.station) || 0) + e.cost);
  }
  for (const [sid, used] of energy) {
    const st = state.scenario.stations.find((s) => s.id === sid);
    if (used > st.battery) {
      throw new CalError('battery-negative',
        `locked energy ${used} exceeds battery ${st.battery} on ${sid}`, 6);
    }
  }
}

export function applyCorrect(state, patch) {
  if (!patch || typeof patch !== 'object') {
    throw new CalError('bad-patch', 'patch must be an object', 2);
  }
  const close = patch.close || {};
  const add = patch.add || {};
  const affected = new Set([...Object.keys(close), ...Object.keys(add)]);
  if (affected.size === 0) throw new CalError('bad-patch', 'no affected stations', 2);
  for (const [sid, wids] of Object.entries(close)) {
    const st = state.scenario.stations.find((s) => s.id === sid);
    if (!st) throw new CalError('unknown-station', `station ${sid} not found`, 2);
    const known = new Set([
      ...st.windows.map((w) => w.id),
      ...((state.added[sid]) || []).map((w) => w.id),
    ]);
    for (const w of wids) {
      if (!known.has(w)) throw new CalError('unknown-window', `window ${w} not found on ${sid}`, 2);
    }
    state.closed[sid] = [...new Set([...(state.closed[sid] || []), ...wids])];
  }
  for (const [sid, wins] of Object.entries(add)) {
    const st = state.scenario.stations.find((s) => s.id === sid);
    if (!st) throw new CalError('unknown-station', `station ${sid} not found`, 2);
    const existing = new Set([
      ...st.windows.map((w) => w.id),
      ...((state.added[sid]) || []).map((w) => w.id),
    ]);
    for (const w of wins) {
      if (!w.id || existing.has(w.id)) {
        throw new CalError('bad-patch', `duplicate or missing window id in add for ${sid}`, 2);
      }
      existing.add(w.id);
      if (!(w.start < w.end)) throw new CalError('bad-window', `window ${w.id} start >= end`, 2);
      if (!(w.cost >= 0)) {
        throw new CalError('battery-negative', `window ${w.id} has negative cost`, 6);
      }
    }
    state.added[sid] = [...(state.added[sid] || []), ...wins];
  }
  checkLockedFeasible(state);
  state.plan = computePlan(state, {affected});
  return {affected: [...affected].sort(cmpStr), plan: state.plan};
}

function revocationToken(failureId, e) {
  return 'rvk_' + sha256hex(stable({
    failure: failureId, station: e.station, window: e.window, start: e.start, end: e.end,
  })).slice(0, 16);
}

export function applyFail(state, {station, from, to}, seq) {
  const st = state.scenario.stations.find((s) => s.id === station);
  if (!st) throw new CalError('unknown-station', `station ${station} not found`, 2);
  if (!(from < to)) throw new CalError('bad-interval', 'from must be < to', 2);
  const id = 'F' + seq;
  const revocations = [];
  const unpreemptable = [];
  const remaining = [];
  for (const e of state.plan.entries) {
    if (e.station === station && overlaps(e.start, e.end, from, to)) {
      if (e.locked) {
        unpreemptable.push(e.window);
        remaining.push(e);
      } else {
        revocations.push(revocationToken(id, e));
      }
    } else {
      remaining.push(e);
    }
  }
  state.plan = finalizePlan(state, remaining);
  const outside = remaining.filter((e) => !overlaps(e.start, e.end, from, to));
  const failure = {
    id, station, from, to,
    restored: false,
    revocations,
    unpreemptable,
    outsideRoot: merkleRoot(outside.map(leafHash)),
  };
  state.failures.push(failure);
  state.revocations.push(...revocations);
  return failure;
}

export function applyRestore(state, {failure: fid}) {
  const f = state.failures.find((x) => x.id === fid && !x.restored);
  if (!f) throw new CalError('unknown-failure', `failure ${fid} not found`, 6);
  f.restored = true;
  state.plan = computePlan(state, {
    affected: new Set([f.station]),
    interval: {station: f.station, from: f.from, to: f.to},
  });
  const outside = state.plan.entries.filter((e) => !overlaps(e.start, e.end, f.from, f.to));
  const after = merkleRoot(outside.map(leafHash));
  if (after !== f.outsideRoot) {
    throw new CalError('history-diverged',
      'history outside the failure interval changed', 6);
  }
  return {
    failure: f.id,
    station: f.station,
    interval: {from: f.from, to: f.to},
    outsideRootBefore: f.outsideRoot,
    outsideRootAfter: after,
    unchanged: true,
    revocations: f.revocations,
  };
}

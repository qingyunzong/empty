import test from 'node:test';
import assert from 'node:assert/strict';
import {computeSchedule} from '../src/scheduler.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function gen(seed) {
  const rnd = lcg(seed);
  const stations = [];
  const contracts = [];
  let budget = 11;
  const nS = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < nS && budget > 0; i++) {
    const id = 'S' + i;
    const nW = 1 + Math.floor(rnd() * Math.min(4, budget));
    budget -= nW;
    const windows = [];
    for (let k = 0; k < nW; k++) {
      const start = Math.floor(rnd() * 10);
      windows.push({id: `${id}w${k}`, start, end: start + 1 + Math.floor(rnd() * 3), cost: 1 + Math.floor(rnd() * 2)});
    }
    stations.push({
      id,
      link: 'L' + Math.floor(rnd() * 2),
      battery: 1 + Math.floor(rnd() * 5),
      windows,
    });
    contracts.push({
      id: 'C' + i,
      station: id,
      min: 1 + Math.floor(rnd() * 3),
      floor: 0,
      period: 3 + Math.floor(rnd() * 4),
      quota: 1 + Math.floor(rnd() * 2),
    });
  }
  return {stations, contracts};
}

function bruteForceMaxSatisfied({stations, contracts}) {
  const items = [];
  for (const s of stations) {
    for (const w of s.windows) {
      for (const c of contracts) {
        if (c.station === s.id) items.push({s, w, c});
      }
    }
  }
  let best = 0;
  const battery = new Map();
  const links = new Map();
  const quota = new Map();
  const counts = new Map();
  const used = new Set();
  function dfs(i) {
    if (i === items.length) {
      let sat = 0;
      for (const c of contracts) if ((counts.get(c.id) || 0) >= c.min) sat++;
      if (sat > best) best = sat;
      return;
    }
    const {s, w, c} = items[i];
    dfs(i + 1);
    const key = s.id + '/' + w.id;
    if (used.has(key)) return;
    if ((battery.get(s.id) || 0) + w.cost > s.battery) return;
    const busy = links.get(s.link) || [];
    if (busy.some(([a, b]) => w.start < b && a < w.end)) return;
    const qk = c.id + '@' + Math.floor(w.start / c.period);
    if ((quota.get(qk) || 0) >= c.quota) return;
    used.add(key);
    battery.set(s.id, (battery.get(s.id) || 0) + w.cost);
    busy.push([w.start, w.end]);
    links.set(s.link, busy);
    quota.set(qk, (quota.get(qk) || 0) + 1);
    counts.set(c.id, (counts.get(c.id) || 0) + 1);
    dfs(i + 1);
    counts.set(c.id, counts.get(c.id) - 1);
    quota.set(qk, quota.get(qk) - 1);
    busy.pop();
    battery.set(s.id, battery.get(s.id) - w.cost);
    used.delete(key);
  }
  dfs(0);
  return best;
}

function checkFeasible({stations, contracts}, entries) {
  const byStation = new Map(stations.map((s) => [s.id, s]));
  const byContract = new Map(contracts.map((c) => [c.id, c]));
  const energy = new Map();
  const links = new Map();
  const quota = new Map();
  const used = new Set();
  for (const e of entries) {
    const st = byStation.get(e.station);
    assert.ok(st, `entry for unknown station ${e.station}`);
    assert.ok(!used.has(e.station + '/' + e.window), 'window reused');
    used.add(e.station + '/' + e.window);
    energy.set(e.station, (energy.get(e.station) || 0) + e.cost);
    const arr = links.get(st.link) || [];
    for (const [a, b] of arr) assert.ok(!(e.start < b && a < e.end), 'mutex overlap');
    arr.push([e.start, e.end]);
    links.set(st.link, arr);
    const c = byContract.get(e.contract);
    const qk = e.contract + '@' + Math.floor(e.start / c.period);
    quota.set(qk, (quota.get(qk) || 0) + 1);
    assert.ok(quota.get(qk) <= c.quota, 'quota exceeded');
  }
  for (const [sid, usedEnergy] of energy) {
    assert.ok(usedEnergy <= byStation.get(sid).battery, 'battery exceeded');
  }
}

test('acceptance 1: scheduler matches exhaustive max-satisfied for n<=11', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const sc = gen(seed);
    const r = computeSchedule({stations: sc.stations, contracts: sc.contracts, fixed: []});
    checkFeasible(sc, r.entries);
    const sat = sc.contracts.filter((c) => (r.counts.get(c.id) || 0) >= c.min).length;
    assert.equal(sat, bruteForceMaxSatisfied(sc), `seed ${seed}`);
  }
});

test('scheduler is deterministic', () => {
  const sc = gen(7);
  const a = computeSchedule({stations: sc.stations, contracts: sc.contracts, fixed: []});
  const b = computeSchedule({stations: sc.stations, contracts: sc.contracts, fixed: []});
  assert.deepEqual(a.entries, b.entries);
});

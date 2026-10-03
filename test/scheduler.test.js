'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');
const { mulberry32 } = require('./helper');

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

function flatWindows(scenario) {
  const out = [];
  for (const st of scenario.stations) {
    const link = st.link || `solo:${st.id}`;
    for (const w of st.windows) {
      out.push({ ...w, station: st.id, link, locked: w.locked === true });
    }
  }
  return out;
}

// Independent brute-force reference: enumerate every subset of free windows
// (locked always in), keep the lexicographically best (satisfied, floored,
// -energy, -count).
function bruteForceBest(scenario) {
  const floor = scenario.floor === undefined ? 1 : scenario.floor;
  const windows = flatWindows(scenario);
  const locked = windows.filter((w) => w.locked);
  const free = windows.filter((w) => !w.locked);
  const batteries = new Map(scenario.stations.map((s) => [s.id, s.battery]));
  const contracts = scenario.contracts || [];
  const feasible = (chosen) => {
    for (let i = 0; i < chosen.length; i++) {
      for (let j = i + 1; j < chosen.length; j++) {
        if (chosen[i].link === chosen[j].link && overlaps(chosen[i], chosen[j])) return false;
      }
    }
    const energy = new Map();
    for (const w of chosen) energy.set(w.station, (energy.get(w.station) || 0) + w.energy);
    for (const [st, e] of energy) if (e > batteries.get(st)) return false;
    // Locked windows are pre-committed: they count toward quota usage but are
    // exempt from the cap themselves (mirrors the scheduler's canAdd rule).
    for (const c of contracts) {
      if (c.period === undefined) continue;
      const perPeriod = new Map();
      const lockedPeriod = new Map();
      for (const w of chosen) {
        if (w.station !== c.station) continue;
        const p = Math.floor(w.start / c.period);
        perPeriod.set(p, (perPeriod.get(p) || 0) + 1);
        if (w.locked) lockedPeriod.set(p, (lockedPeriod.get(p) || 0) + 1);
      }
      for (const [p, n] of perPeriod) {
        if (n > Math.max(c.quota, lockedPeriod.get(p) || 0)) return false;
      }
    }
    return true;
  };
  const score = (chosen) => {
    let satisfied = 0;
    for (const c of contracts) {
      const n = chosen.filter((w) => w.station === c.station).length;
      if (n >= c.min) satisfied++;
    }
    let floored = 0;
    const contracted = new Set(contracts.map((c) => c.station));
    for (const st of contracted) {
      const n = chosen.filter((w) => w.station === st).length;
      if (n >= floor) floored++;
    }
    let energy = 0;
    for (const w of chosen) energy += w.energy;
    return [satisfied, floored, -energy, -chosen.length];
  };
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  let best = null;
  for (let mask = 0; mask < 1 << free.length; mask++) {
    const chosen = locked.slice();
    for (let i = 0; i < free.length; i++) if (mask & (1 << i)) chosen.push(free[i]);
    if (!feasible(chosen)) continue;
    const s = score(chosen);
    if (best === null || cmp(s, best) > 0) best = s;
  }
  return best;
}

function planScore(scenario, plan) {
  const floor = scenario.floor === undefined ? 1 : scenario.floor;
  const contracts = scenario.contracts || [];
  let satisfied = 0;
  for (const c of contracts) {
    if (plan.schedule[c.station].length >= c.min) satisfied++;
  }
  let floored = 0;
  const contracted = new Set(contracts.map((c) => c.station));
  for (const st of contracted) {
    if (plan.schedule[st].length >= floor) floored++;
  }
  let energy = 0;
  let count = 0;
  for (const st of Object.keys(plan.schedule)) {
    for (const e of plan.schedule[st]) {
      energy += e.energy;
      count++;
    }
  }
  return [satisfied, floored, -energy, -count];
}

function assertPlanFeasible(scenario, plan) {
  const batteries = new Map(scenario.stations.map((s) => [s.id, s.battery]));
  const links = new Map(scenario.stations.map((s) => [s.id, s.link || `solo:${s.id}`]));
  const entries = [];
  for (const [st, wins] of Object.entries(plan.schedule)) {
    let energy = 0;
    for (const w of wins) {
      energy += w.energy;
      entries.push({ ...w, station: st, link: links.get(st) });
    }
    assert.ok(energy <= batteries.get(st), `battery exceeded on ${st}`);
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      assert.ok(
        entries[i].link !== entries[j].link || !overlaps(entries[i], entries[j]),
        `mutex overlap: ${entries[i].window} vs ${entries[j].window}`
      );
    }
  }
  for (const c of scenario.contracts || []) {
    if (c.period === undefined) continue;
    const perPeriod = new Map();
    const lockedPeriod = new Map();
    for (const w of plan.schedule[c.station]) {
      const p = Math.floor(w.start / c.period);
      perPeriod.set(p, (perPeriod.get(p) || 0) + 1);
      if (w.locked) lockedPeriod.set(p, (lockedPeriod.get(p) || 0) + 1);
    }
    for (const [p, n] of perPeriod) {
      assert.ok(n <= Math.max(c.quota, lockedPeriod.get(p) || 0), `quota exceeded for ${c.id}`);
    }
  }
}

function randomScenario(rng) {
  const nSt = 2 + Math.floor(rng() * 2);
  const links = ['L1', 'L2'];
  const stations = [];
  let total = 0;
  for (let i = 0; i < nSt; i++) {
    const nw = 2 + Math.floor(rng() * 3);
    total += nw;
    if (total > 11) return null;
    const windows = [];
    for (let j = 0; j < nw; j++) {
      const start = Math.floor(rng() * 10);
      windows.push({
        id: `s${i}w${j}`,
        start,
        end: start + 1 + Math.floor(rng() * 3),
        energy: 1 + Math.floor(rng() * 3),
      });
    }
    stations.push({
      id: `st${i}`,
      link: links[Math.floor(rng() * links.length)],
      battery: 4 + Math.floor(rng() * 8),
      windows,
    });
  }
  const lockedByLink = new Map();
  for (const st of stations) {
    for (const w of st.windows) {
      if (rng() >= 0.25) continue;
      const arr = lockedByLink.get(st.link) || [];
      if (arr.some((o) => overlaps(o, w))) continue;
      w.locked = true;
      arr.push(w);
      lockedByLink.set(st.link, arr);
    }
  }
  for (const st of stations) {
    const e = st.windows.filter((w) => w.locked).reduce((s, w) => s + w.energy, 0);
    if (e > st.battery) st.windows.forEach((w) => delete w.locked);
  }
  const contracts = stations.map((st, i) => {
    const c = { id: `C${i}`, station: st.id, min: 1 + Math.floor(rng() * 3) };
    if (rng() < 0.4) {
      c.period = 3 + Math.floor(rng() * 4);
      c.quota = 1 + Math.floor(rng() * 2);
    }
    return c;
  });
  return { name: 'fuzz', stations, contracts };
}

test('acceptance 1: n<=11 plan matches exhaustive best score', () => {
  let runs = 0;
  for (let seed = 1; seed <= 200 && runs < 40; seed++) {
    const rng = mulberry32(seed);
    const scenario = randomScenario(rng);
    if (!scenario) continue;
    runs++;
    const { plan } = engine.fold(scenario, []);
    assertPlanFeasible(scenario, plan);
    const got = planScore(scenario, plan);
    const want = bruteForceBest(scenario);
    assert.deepEqual(got, want, `seed ${seed}: plan score ${got} != exhaustive ${want}`);
  }
  assert.ok(runs >= 40, 'enough fuzz iterations');
});

test('planning is deterministic across folds', () => {
  const rng = mulberry32(99);
  const scenario = randomScenario(rng);
  const a = engine.fold(scenario, []).plan;
  const b = engine.fold(scenario, []).plan;
  assert.equal(a.planId, b.planId);
});

test('greedy path (>16 candidates) stays feasible and deterministic', () => {
  const stations = [];
  const contracts = [];
  for (let i = 0; i < 3; i++) {
    const windows = [];
    for (let j = 0; j < 10; j++) {
      windows.push({ id: `s${i}w${j}`, start: j * 2 + (i % 2), end: j * 2 + (i % 2) + 1, energy: 1 });
    }
    stations.push({ id: `st${i}`, link: i < 2 ? 'shared' : `solo${i}`, battery: 6, windows });
    contracts.push({ id: `C${i}`, station: `st${i}`, min: 4 });
  }
  const scenario = { name: 'big', stations, contracts };
  const a = engine.fold(scenario, []).plan;
  const b = engine.fold(scenario, []).plan;
  assert.equal(a.planId, b.planId);
  assertPlanFeasible(scenario, a);
  const satisfied = contracts.filter((c) => a.schedule[c.station].length >= c.min).length;
  assert.ok(satisfied >= 2, `expected most contracts satisfied, got ${satisfied}`);
});

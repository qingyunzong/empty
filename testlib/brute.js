'use strict';

// Reference implementation: enumerate every stage combination and pick the
// best feasible one with the same cost semantics as the solver.
const { buildContext, costTuple, compareTuples, EPS } = require('../src/solver');

function shedOf(model, i, stage) {
  return model.loads[i].shedPerStage * stage;
}

function isFeasible(model, ctx, stages, gap) {
  const indexOf = model.loadIndex;
  for (let i = 0; i < model.loads.length; i += 1) {
    const load = model.loads[i];
    if (load.fixedStage !== null && stages[i] !== load.fixedStage) return false;
  }
  for (const lock of model.interlocks) {
    if (lock.type === 'noshed' && stages[indexOf.get(lock.load)] !== 0) return false;
    if (lock.type === 'together') {
      const idx = lock.loads.map((id) => indexOf.get(id));
      for (let k = 1; k < idx.length; k += 1) {
        if (stages[idx[k]] !== stages[idx[0]]) return false;
      }
    }
    if (lock.type === 'order') {
      if (stages[indexOf.get(lock.first)] < stages[indexOf.get(lock.then)]) return false;
    }
  }
  for (let f = 0; f < model.feeders.length; f += 1) {
    let sum = 0;
    for (const i of ctx.feederLoads[f]) sum += shedOf(model, i, stages[i]);
    if (sum > model.feeders[f].capacity + EPS) return false;
  }
  let total = 0;
  for (let i = 0; i < model.loads.length; i += 1) total += shedOf(model, i, stages[i]);
  return total >= gap - EPS;
}

function bruteForce(model, gap) {
  const ctx = buildContext(model);
  const n = model.loads.length;
  const stages = new Array(n).fill(0);
  let best = null;

  function visit(i) {
    if (i === n) {
      if (!isFeasible(model, ctx, stages, gap)) return;
      const tuple = costTuple(model, ctx.cost, (k) => shedOf(model, k, stages[k]));
      if (best === null || compareTuples(tuple, best.tuple) < 0) {
        best = { tuple, plan: stages.slice() };
      }
      return;
    }
    for (let s = 0; s <= model.loads[i].maxStage; s += 1) {
      stages[i] = s;
      visit(i + 1);
    }
  }
  visit(0);
  return best;
}

// Independent plan checker used to validate solver output.
function checkPlan(model, plan, gap) {
  const stages = model.loads.map((l) => {
    const s = plan[l.id];
    if (!Number.isInteger(s) || s < 0 || s > l.maxStage) return null;
    return s;
  });
  if (stages.includes(null)) return false;
  const ctx = buildContext(model);
  return isFeasible(model, ctx, stages, gap);
}

function totalShed(model, plan) {
  let total = 0;
  model.loads.forEach((load, i) => {
    total += model.loads[i].shedPerStage * plan[load.id];
  });
  return total;
}

// Deterministic PRNG (mulberry32) for reproducible random instances.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomModel(rand, { loadCount, feederCount = 2, maxK = 3, interlockDensity = 0.5 }) {
  const feeders = [];
  for (let f = 0; f < feederCount; f += 1) {
    feeders.push({ id: `F${f + 1}`, capacity: 0, loads: [] });
  }
  for (let i = 0; i < loadCount; i += 1) {
    const feeder = feeders[Math.floor(rand() * feederCount)];
    const power = 10 + Math.floor(rand() * 90);
    feeder.loads.push({
      id: `L${i + 1}`,
      power,
      level: 1 + Math.floor(rand() * 3),
      maxStage: 1 + Math.floor(rand() * maxK),
    });
    feeder.capacity += power;
  }
  for (const feeder of feeders) {
    // capacity between 40% and 100% of the feeder total
    feeder.capacity = Math.round(feeder.capacity * (0.4 + rand() * 0.6));
  }
  const ids = [];
  for (let i = 0; i < loadCount; i += 1) ids.push(`L${i + 1}`);
  const interlocks = [];
  if (rand() < interlockDensity && loadCount >= 2) {
    const a = ids[Math.floor(rand() * loadCount)];
    let b = ids[Math.floor(rand() * loadCount)];
    if (b !== a) interlocks.push({ type: 'order', first: a, then: b });
  }
  if (rand() < interlockDensity && loadCount >= 3) {
    const shuffled = [...ids].sort(() => rand() - 0.5);
    interlocks.push({ type: 'together', loads: shuffled.slice(0, 2) });
  }
  if (rand() < interlockDensity * 0.5) {
    interlocks.push({ type: 'noshed', load: ids[Math.floor(rand() * loadCount)] });
  }
  return { feeders, interlocks };
}

module.exports = { bruteForce, checkPlan, totalShed, rng, randomModel };

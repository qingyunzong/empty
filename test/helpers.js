'use strict';

// Deterministic PRNG (mulberry32) so randomized tests are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng.next ? rng.next() : rng() * (hi - lo + 1));
}

function randomProblem(rng, opts = {}) {
  const n = opts.n ?? 6;
  const maxModes = opts.maxModes ?? 3;
  const partNames = opts.parts ?? [];
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    const id = `T${i}`;
    const deps = [];
    for (let j = 0; j < i; j += 1) {
      if (rng() < (opts.depProb ?? 0.3)) deps.push(`T${j}`);
    }
    const modeCount = 1 + Math.floor(rng() * maxModes);
    const modes = [];
    for (let m = 0; m < modeCount; m += 1) {
      const parts = {};
      for (const p of partNames) {
        if (rng() < 0.4) parts[p] = 1 + Math.floor(rng() * 2);
      }
      modes.push({
        id: `m${m}`,
        duration: 1 + Math.floor(rng() * 9),
        cost: Math.floor(rng() * 50),
        parts,
      });
    }
    tasks.push({
      id,
      deps,
      downtime: 1 + Math.floor(rng() * 5),
      deferPenalty: 5 + Math.floor(rng() * 25),
      modes,
    });
  }
  const minCost = tasks.reduce((s, t) => s + Math.min(...t.modes.map((m) => m.cost)), 0);
  const budgetFactor = opts.budgetFactor ?? (0.4 + rng() * 1.2);
  const budget = Math.floor(minCost * budgetFactor);
  const parts = {};
  for (const p of partNames) parts[p] = Math.floor(rng() * 4);
  return { budget, crews: 2, parts, tasks };
}

module.exports = { mulberry32, randomProblem };

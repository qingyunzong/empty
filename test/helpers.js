import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic PRNG (mulberry32) so test DAGs are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomDagDoc(n, rand, { edgeProb = 0.25, nullCostProb = 0, nullRateProb = 0 } = {}) {
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const deps = [];
    for (let j = 0; j < i; j++) {
      if (rand() < edgeProb) deps.push(`t${j}`);
    }
    const cost = {
      cpu: rand() < nullCostProb ? null : 1 + Math.floor(rand() * 4),
      mem: rand() < nullCostProb ? null : 1 + Math.floor(rand() * 4),
      wall: rand() < nullCostProb ? null : 1 + Math.floor(rand() * 4),
    };
    tasks.push({
      id: `t${i}`,
      deps,
      cost,
      failRate: rand() < nullRateProb ? null : Math.round(rand() * 50) / 100,
      value: 1 + Math.floor(rand() * 10),
    });
  }
  return { tasks };
}

export function randomBudget(rand) {
  return {
    cpu: 4 + Math.floor(rand() * 10),
    mem: 4 + Math.floor(rand() * 10),
    wall: 4 + Math.floor(rand() * 10),
  };
}

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replan-test-'));
}

export function writeJson(dir, name, doc) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  return p;
}

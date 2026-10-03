// Deterministic seeded PRNG (mulberry32) for reproducible random instances.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInstance(rand, { n = 5, maxParams = 2, maxMachines = 2 } = {}) {
  const machines = 1 + Math.floor(rand() * maxMachines);
  const steps = [];
  for (let i = 0; i < n; i++) {
    const nParams = 1 + Math.floor(rand() * maxParams);
    steps.push({
      id: 's' + i,
      params: Array.from({ length: nParams }, (_, k) => 'p' + k),
      memory: Math.floor(rand() * 4),
      duration: 1 + Math.floor(rand() * 3),
    });
  }
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < 0.3) edges.push(['s' + i, 's' + j]);
    }
  }
  const compat = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < 0.25 && steps[i].params.length > 1 && steps[j].params.length > 1) {
        const allow = [];
        for (const pa of steps[i].params) {
          for (const pb of steps[j].params) {
            if (rand() < 0.7) allow.push([pa, pb]);
          }
        }
        compat.push({ between: ['s' + i, 's' + j], allow });
      }
    }
  }
  return {
    machines,
    memoryLimit: Math.floor(rand() * 5),
    steps,
    edges,
    compat,
  };
}

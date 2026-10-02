// Deterministic example generator (seeded), used by tests and examples.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeInstance(seed = 42, n = 12) {
  const rnd = mulberry32(seed);
  const molds = ['A', 'B', 'C'];
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push({
      id: `J${i}`,
      due: 8 + Math.floor(rnd() * 40),
      work: 1 + Math.floor(rnd() * 6),
      energy: 1 + Math.floor(rnd() * 4),
      mold: molds[Math.floor(rnd() * molds.length)],
    });
  }
  const used = [...new Set(jobs.map((j) => j.mold))].sort();
  const setup = used.map((_, r) =>
    used.map((_, c) => (r === c ? 0 : 1 + Math.floor(rnd() * 5))));
  const energyBudget = jobs.reduce((a, j) => a + j.energy, 0); // feasible
  return { jobs, setup, energyBudget };
}

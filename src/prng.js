// Deterministic 32-bit PRNG (mulberry32). Pure integer arithmetic, so the
// same seed yields the same stream in every Node.js process on any platform.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Arrival times are integers. The first arrival is at `start`; each following
// arrival adds an integer interval in [0, maxInterval] drawn from the seeded
// stream. Priorities are integers in [0, priorityLevels) from the same stream.
export function generateArrivals({ seed = 0, count = 0, start = 0, maxInterval = 1, priorityLevels = 3 } = {}) {
  const rand = mulberry32(seed);
  const arrivals = [];
  let time = start;
  for (let i = 0; i < count; i += 1) {
    if (i > 0) time += Math.floor(rand() * (maxInterval + 1));
    arrivals.push({ id: i + 1, time, priority: Math.floor(rand() * priorityLevels) });
  }
  return arrivals;
}

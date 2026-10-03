'use strict';

const { mulberry32 } = require('./prng');

// Generate a reproducible arrival stream from a seed.
// Each arrival: { id, time, priority, seq }.
// `seq` is the generation index and provides the stable tie-break
// for arrivals that share the same timestamp.
function generateArrivals({ seed = 1, count = 10, startTime = 0, maxGap = 5, maxPriority = 3 } = {}) {
  const rand = mulberry32(seed);
  const arrivals = [];
  let t = startTime;
  for (let i = 0; i < count; i++) {
    t += Math.floor(rand() * (maxGap + 1));
    const priority = Math.floor(rand() * maxPriority);
    arrivals.push({ id: `J${i}`, time: t, priority, seq: i });
  }
  return arrivals;
}

module.exports = { generateArrivals };

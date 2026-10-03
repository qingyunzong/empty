'use strict';

// Exact optimum for small n (<= 12): maximum number of samples that can be
// simultaneously placed under the hard constraints (zone, capacity,
// same-project adjacency, project quota). Used by tests as ground truth.

function feasible(config, samples) {
  const counts = new Map();
  for (const s of samples) counts.set(s.project, (counts.get(s.project) || 0) + 1);
  for (const [project, count] of counts) {
    const q = config.quotas[project] === undefined ? Infinity : config.quotas[project];
    if (count > q) return false;
  }
  const racks = config.racks.map((r) => ({ zone: r.zone, slots: new Array(r.capacity).fill(null) }));
  const order = [...samples].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  function bt(idx) {
    if (idx === order.length) return true;
    const s = order[idx];
    for (const rack of racks) {
      if (rack.zone !== s.zone) continue;
      const projectSlots = [];
      const free = [];
      for (let i = 0; i < rack.slots.length; i++) {
        const occ = rack.slots[i];
        if (occ === null) free.push(i);
        else if (occ.project === s.project) projectSlots.push(i);
      }
      const candidates = projectSlots.length > 0
        ? free.filter((i) => projectSlots.some((j) => Math.abs(i - j) === 1))
        : free;
      for (const i of candidates) {
        rack.slots[i] = s;
        if (bt(idx + 1)) return true;
        rack.slots[i] = null;
      }
    }
    return false;
  }
  return bt(0);
}

function popcount(x) {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

function maxPlaceable(config, samples) {
  const n = samples.length;
  let best = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    const count = popcount(mask);
    if (count <= best) continue;
    const subset = samples.filter((_, i) => mask & (1 << i));
    if (feasible(config, subset)) best = count;
  }
  return best;
}

module.exports = { feasible, maxPlaceable };

export const CONFIG = {
  species: {
    FES: { morph: 'grass' },
    POA: { morph: 'grass' },
    ROS: { morph: 'shrub' },
    FES2: { morph: 'grass' },
  },
  plots: {
    Q1: { area: 10, morphs: ['grass', 'shrub'] },
    Q2: { area: 4, morphs: ['grass'] },
  },
  tiers: [0, 1, 2, 3],
  tierWeights: { 0: 0, 1: 1, 2: 2, 3: 4 },
  capacityPerArea: 1,
};

// Build a JSONL history for one device; time defaults to line order.
export function hist(device, ...ops) {
  return ops.map((o, i) => JSON.stringify({ device, time: i + 1, ...o })).join('\n');
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

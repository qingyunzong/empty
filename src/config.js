export const DEFAULT_CONFIG = {
  objectives: ['20x', '40x', '63x'],
  switchCost: 2,
  channels: ['DAPI', 'GFP', 'RFP', 'Cy5'],
  channelExclusions: [['GFP', 'RFP'], ['RFP', 'Cy5']],
  channelFlush: 1,
  horizon: 200,
  maxConsecutive: 2,
  quotas: { default: 100 },
};

export function exclusionSet(cfg) {
  const s = new Set();
  for (const [a, b] of cfg.channelExclusions) {
    s.add(a + '|' + b);
    s.add(b + '|' + a);
  }
  return s;
}

export function channelsExcluded(cfg, cs1, cs2) {
  const s = exclusionSet(cfg);
  for (const x of cs1) for (const y of cs2) if (s.has(x + '|' + y)) return true;
  return false;
}

export function excludedPairWithin(cfg, channels) {
  const s = exclusionSet(cfg);
  for (let i = 0; i < channels.length; i++)
    for (let j = i + 1; j < channels.length; j++)
      if (s.has(channels[i] + '|' + channels[j])) return [channels[i], channels[j]];
  return null;
}

export function quotaOf(cfg, group) {
  return cfg.quotas[group] ?? cfg.quotas.default ?? Infinity;
}

import { DEFAULT_CONFIG } from './config.js';

export function createState(config = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    quotas: { ...DEFAULT_CONFIG.quotas, ...(config.quotas || {}) },
    channelExclusions: config.channelExclusions ?? DEFAULT_CONFIG.channelExclusions,
  };
  return {
    version: 1,
    config: cfg,
    clock: 0,
    generation: 0,
    batches: {},
    segments: [],
    maintenance: [],
    imaged: [],
    groups: {},
    generations: [],
  };
}

export function remaining(b) {
  return b.fieldsTotal - b.fieldsImaged;
}

export function imagedRuns(state) {
  const sorted = state.imaged.slice().sort((a, b) => a.slot - b.slot);
  const runs = [];
  for (const f of sorted) {
    const last = runs[runs.length - 1];
    if (last && f.slot === last.end && f.batchId === last.batchId) {
      last.end++;
    } else {
      runs.push({
        start: f.slot,
        end: f.slot + 1,
        batchId: f.batchId,
        like: { objective: f.objective, channels: f.channels, group: f.group },
      });
    }
  }
  return runs;
}

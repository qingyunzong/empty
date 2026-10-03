import { canonical, sha256 } from './util.js';

export function defaultConfig() {
  return {
    horizon: 64,                 // 机时容量(槽位数)
    objectiveSwitchCost: 2,      // 物镜切换成本(空闲槽)
    channelPurgeGap: 3,          // 互斥通道清洗间隔(空闲槽)
    maxConsecutivePreemptions: 2,// 连续抢占上限(防抖动)
    defaultQuota: 8,             // 课题组默认配额(每轮扫描可接纳视野数)
    objectives: ['10x', '20x', '40x'],
    channels: ['DAPI', 'GFP', 'RFP', 'Cy5'],
    exclusivePairs: [['GFP', 'RFP']],
    groups: {},                  // name -> { quota }
  };
}

export function newState(config) {
  return {
    config,
    now: 0,
    seq: 0,
    batchSeq: 0,
    batches: {},
    slots: Array(config.horizon).fill(null), // null | {t:'maint'} | {t:'scan',batch,fov,imaged}
    maintenance: [],
    images: [],                  // 已出具图像(不可改)
    groupLastServed: {},         // 课题组 -> 最近被服务的事件序号
    proof: 'genesis',
  };
}

export function pairKey(a, b) {
  return [a, b].sort().join('|');
}

const exCache = new WeakMap();
export function exclusiveSet(config) {
  let s = exCache.get(config);
  if (!s) {
    s = new Set(config.exclusivePairs.map(([a, b]) => pairKey(a, b)));
    exCache.set(config, s);
  }
  return s;
}

export function channelsExclusive(config, chA, chB) {
  const set = exclusiveSet(config);
  for (const a of chA) for (const b of chB) if (set.has(pairKey(a, b))) return true;
  return false;
}

// 相邻批次间的转换成本:物镜不同收切换成本,通道互斥收清洗间隔,可叠加
export function transitionCost(config, a, b) {
  if (!a || !b || a.id === b.id) return 0;
  let cost = 0;
  if (a.objective !== b.objective) cost += config.objectiveSwitchCost;
  if (channelsExclusive(config, a.channels, b.channels)) cost += config.channelPurgeGap;
  return cost;
}

export function quotaOf(state, group) {
  return state.config.groups[group]?.quota ?? state.config.defaultQuota;
}

export function computeProof(state) {
  const { proof, ...rest } = state;
  return sha256(proof + '\n' + canonical(rest));
}

export function seal(state) {
  state.proof = computeProof(state);
  return state.proof;
}

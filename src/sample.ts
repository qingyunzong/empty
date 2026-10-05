// 确定性样例生成：16 个广告组、3 个渠道、非线性整数收益表。
import type { PlanInput } from './model.js';
import { seededRng, randInt } from './util.js';

export function generateSample(seed = 20261005): PlanInput {
  const rng = seededRng(seed);
  const channels = [
    { id: 'search', budget: 60 },
    { id: 'social', budget: 45 },
    { id: 'video', budget: 50 },
  ];
  const groups = Array.from({ length: 16 }, (_, i) => {
    const channel = channels[i % channels.length].id;
    const unitCost = randInt(rng, 1, 5);
    const unitExposure = randInt(rng, 1, 4);
    const base = randInt(rng, 3, 9);
    const bumpAt = randInt(rng, 2, 8);
    const bump = randInt(rng, 4, 14);
    // 非线性收益表：线性项 + 平方根递减边际 + 随机阶梯跳点，全部取整。
    const revenue = Array.from({ length: 11 }, (_, q) =>
      q === 0 ? 0 : Math.round(base * Math.sqrt(q) * 2 + (q >= bumpAt ? bump : 0) + randInt(rng, 0, 3)),
    );
    return { id: `g${String(i + 1).padStart(2, '0')}`, channel, unitCost, unitExposure, revenue };
  });
  return { channels, exposureLowerBound: 40, groups };
}

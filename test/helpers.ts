import { InternalNode, LeafNode, Problem, TreeNode } from '../src/index.js';

/** 确定性伪随机数(LCG), 保证测试可复现. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export interface RandomProblemOptions {
  leafCount: number;
  maxAlloc: number;
  budget: number;
  withFees?: boolean;
  crossCount?: number;
}

/**
 * 生成随机问题: 两层树(根 + 若干内部节点), 叶收益表完全随机(一般不凹).
 */
export function randomProblem(rng: () => number, opts: RandomProblemOptions): Problem {
  const { leafCount, maxAlloc, budget } = opts;
  const groupCount = Math.max(1, randInt(rng, 1, Math.min(3, leafCount)));
  const leaves: LeafNode[] = [];
  for (let i = 0; i < leafCount; i++) {
    const max = randInt(rng, 1, maxAlloc);
    const min = randInt(rng, 0, Math.min(1, max));
    const payoff: number[] = [];
    for (let x = 0; x <= max; x++) payoff.push(randInt(rng, 0, 20));
    const leaf: LeafNode = { kind: 'leaf', id: `L${i}`, min, max, payoff };
    if (opts.withFees && rng() < 0.5) leaf.startupFee = randInt(rng, 1, 3);
    leaves.push(leaf);
  }
  const groups: InternalNode[] = [];
  for (let g = 0; g < groupCount; g++) {
    groups.push({ kind: 'internal', id: `G${g}`, min: 0, max: 80, children: [] });
  }
  leaves.forEach((leaf, i) => groups[i % groupCount].children.push(leaf));
  // 随机收紧部分组界(保持可能可行)
  for (const g of groups) {
    const sumMin = g.children.reduce((s, c) => s + c.min, 0);
    const sumMax = g.children.reduce((s, c) => s + c.max, 0);
    g.min = randInt(rng, 0, sumMin);
    g.max = randInt(rng, Math.min(sumMin, sumMax), sumMax);
  }
  const root: TreeNode =
    groups.length === 1 && rng() < 0.5
      ? groups[0]
      : {
          kind: 'internal',
          id: 'R',
          min: 0,
          max: 80,
          children: groups,
        };
  const problem: Problem = { root, totalBudget: budget };
  const crossCount = opts.crossCount ?? 0;
  if (crossCount > 0) {
    problem.cross = [];
    for (let k = 0; k < crossCount; k++) {
      const a = randInt(rng, 0, leafCount - 1);
      let b = randInt(rng, 0, leafCount - 1);
      if (b === a) b = (b + 1) % leafCount;
      problem.cross.push({
        leafA: `L${a}`,
        leafB: `L${b}`,
        maxDiff: randInt(rng, 0, maxAlloc),
      });
    }
  }
  return problem;
}

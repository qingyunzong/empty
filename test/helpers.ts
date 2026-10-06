import { CrossConstraint, NodeSpec, Problem } from '../src/model';

/** Deterministic PRNG (mulberry32) for reproducible randomized tests. */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

export interface GenOptions {
  budget: number;
  maxDepth?: number;
  withFees?: boolean;
  withConstraints?: boolean;
  maxConstraints?: number;
}

/** Random small tree with arbitrary (possibly non-concave) payoff tables. */
export function randomProblem(rand: () => number, opts: GenOptions): Problem {
  const budget = opts.budget;
  const maxDepth = opts.maxDepth ?? 3;
  let nextId = 0;
  const genId = () => `n${nextId++}`;

  const genNode = (depth: number): NodeSpec => {
    if (depth >= maxDepth || rand() < 0.45) {
      const cap = randInt(rand, 1, budget);
      const payoff: number[] = [];
      for (let x = 0; x <= cap; x++) payoff.push(randInt(rand, 0, 12));
      const leaf: NodeSpec['leaf'] = { payoff };
      if (opts.withFees && rand() < 0.5) leaf.startupFee = randInt(rand, 0, 5);
      const min = randInt(rand, 0, Math.ceil(budget / 2));
      const max = min + randInt(rand, 0, budget - min);
      return { id: genId(), min, max, leaf };
    }
    const childCount = randInt(rand, 2, 3);
    const children: NodeSpec[] = [];
    for (let i = 0; i < childCount; i++) children.push(genNode(depth + 1));
    const min = randInt(rand, 0, Math.ceil(budget / 2));
    const max = min + randInt(rand, 0, budget - min);
    return { id: genId(), min, max, children };
  };

  const root = genNode(0);

  const countLeaves = (node: NodeSpec): number =>
    node.leaf ? 1 : (node.children ?? []).reduce((acc, c) => acc + countLeaves(c), 0);
  const leafCount = countLeaves(root);

  const constraints: CrossConstraint[] = [];
  if (opts.withConstraints && leafCount >= 2) {
    const pairs: [number, number][] = [];
    for (let a = 0; a < leafCount; a++) {
      for (let b = a + 1; b < leafCount; b++) pairs.push([a, b]);
    }
    const limit = Math.min(opts.maxConstraints ?? 4, pairs.length);
    const k = randInt(rand, 1, limit);
    for (let i = 0; i < k && pairs.length > 0; i++) {
      const idx = randInt(rand, 0, pairs.length - 1);
      const [a, b] = pairs.splice(idx, 1)[0];
      constraints.push({ a, b, maxDiff: randInt(rand, 0, 4) });
    }
  }

  return { budget, root, constraints };
}

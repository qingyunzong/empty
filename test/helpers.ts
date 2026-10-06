import { Problem, Tier } from "../src/types.js";

/** 确定性伪随机数发生器（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

/** 生成随机小规模问题（可用于暴力枚举核验）。 */
export function randomProblem(rng: () => number): Problem {
  const n = int(rng, 1, 6);
  const users: Tier[][] = [];
  for (let u = 0; u < n; u++) {
    const tiers: Tier[] = [{ r1: 0, r2: 0, profit: 0 }];
    const cnt = int(rng, 1, 3);
    for (let t = 0; t < cnt; t++) {
      tiers.push({ r1: int(rng, 0, 6), r2: int(rng, 0, 6), profit: int(rng, 0, 12) });
    }
    users.push(tiers);
  }
  const pick2 = (): [number, number] => {
    const i = int(rng, 0, n - 1);
    let j = int(rng, 0, n - 1);
    if (j === i) j = (j + 1) % n;
    return i < j ? [i, j] : [j, i];
  };
  const combos = [];
    for (let k = 0, c = n > 1 ? int(rng, 0, 3) : 0; k < c; k++) {
    const [i, j] = pick2();
    combos.push({
      i, j,
      ti: int(rng, 0, users[i].length - 1),
      tj: int(rng, 0, users[j].length - 1),
      bonus: int(rng, -3, 8),
    });
  }
  const sameTier: [number, number][] = [];
  const diffTier: [number, number][] = [];
  if (n > 1) {
    for (let k = 0, c = int(rng, 0, 2); k < c; k++) sameTier.push(pick2());
    for (let k = 0, c = int(rng, 0, 2); k < c; k++) diffTier.push(pick2());
  }
  return {
    users,
    budget1: int(rng, 4, 18),
    budget2: int(rng, 4, 18),
    combos,
    sameTier,
    diffTier,
  };
}

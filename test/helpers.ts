/** Deterministic test helpers: seeded PRNG + random small problems. */

import { Problem } from "../src/model.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random bit-only planning problem; may or may not be solvable. */
export function randomProblem(seed: number, numBits = 4, numActions = 6): Problem {
  const rnd = mulberry32(seed);
  const pick = (n: number) => Math.floor(rnd() * n);

  const actions = [];
  for (let i = 0; i < numActions; i++) {
    const pre: Record<string, 0 | 1> = {};
    const nPre = pick(3);
    for (let j = 0; j < nPre; j++) pre[String(pick(numBits))] = pick(2) as 0 | 1;
    // Distinct bits per action so generated actions are never mutex.
    const pool = Array.from({ length: numBits }, (_, b) => b);
    const nEff = 1 + pick(2);
    const effects = [];
    for (let j = 0; j < nEff; j++) {
      const bit = pool.splice(pick(pool.length), 1)[0]!;
      effects.push({ set: { [String(bit)]: pick(2) as 0 | 1 } });
    }
    actions.push({ name: `a${i}`, pre: { bits: pre }, effects });
  }

  const goalBits: Record<string, 0 | 1> = {};
  const nGoal = 1 + pick(2);
  for (let j = 0; j < nGoal; j++) goalBits[String(pick(numBits))] = 1;

  return {
    name: `random-${seed}`,
    numBits,
    resources: [],
    initialBits: 0,
    goal: { bits: goalBits },
    actions,
  };
}

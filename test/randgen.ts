/** Seeded random problem generator for cross-check tests. */

import { ProblemDef } from "../src/model.js";

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

export function randomProblemDef(rnd: () => number, opts?: { maxBits?: number; withResources?: boolean }): ProblemDef {
  const bits = 3 + Math.floor(rnd() * ((opts?.maxBits ?? 4) - 2)); // 3..maxBits
  const m = 1 << bits;
  const subMask = (): number => {
    let v = 0;
    for (let b = 0; b < bits; b++) if (rnd() < 0.3) v |= 1 << b;
    return v;
  };
  const disjointPair = (): [number, number] => {
    const a = subMask();
    const b = subMask() & ~a & (m - 1);
    return [a, b];
  };
  const withRes = opts?.withResources ?? rnd() < 0.5;
  const resNames = withRes ? (rnd() < 0.5 ? ["r0"] : ["r0", "r1"]) : [];
  const nActions = 4 + Math.floor(rnd() * 4);
  const actions = [];
  for (let i = 0; i < nActions; i++) {
    const [requireMask, forbidMask] = disjointPair();
    const [setMask, clearMask] = disjointPair();
    const cond = [];
    const nCond = Math.floor(rnd() * 3);
    for (let c = 0; c < nCond; c++) {
      const [cr, cf] = disjointPair();
      const [cs, cc] = disjointPair();
      cond.push({ requireMask: cr, forbidMask: cf, setMask: cs, clearMask: cc });
    }
    const cost: Record<string, number> = {};
    for (const n of resNames) if (rnd() < 0.5) cost[n] = 1;
    actions.push({ name: `a${i}`, requireMask, forbidMask, setMask, clearMask, cond, cost });
  }
  const [gr, gf] = disjointPair();
  const resources: Record<string, number> = {};
  for (const n of resNames) resources[n] = 1 + Math.floor(rnd() * 3);
  return {
    bits,
    initial: Math.floor(rnd() * m),
    goal: { requireMask: gr, forbidMask: gf },
    ...(resNames.length > 0 ? { resources } : {}),
    actions,
  };
}

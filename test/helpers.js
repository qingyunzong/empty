import * as Q from '../src/rational.js';
import { partyOf } from '../src/eventlog.js';

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

export const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// Independent naive net computation: BFS over the rate graph from base,
// then plain rational sums. Used to cross-check the engine.
export function naiveNets(effectiveEvents, base) {
  const adj = new Map();
  const addEdge = (from, to, rate) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, rate });
  };
  for (const e of effectiveEvents) {
    if (e.type !== 'setRate') continue;
    // value(from) = rate * value(to)
    addEdge(e.from, e.to, Q.div(Q.ONE, e.rate));
    addEdge(e.to, e.from, e.rate);
  }
  const value = new Map([[base, Q.ONE]]);
  const queue = [base];
  while (queue.length) {
    const x = queue.shift();
    for (const { to, rate } of adj.get(x) ?? []) {
      if (!value.has(to)) {
        value.set(to, Q.mul(value.get(x), rate));
        queue.push(to);
      }
    }
  }
  const nets = new Map();
  for (const e of effectiveEvents) {
    if (e.type !== 'addInvoice') continue;
    const p = partyOf(e.id);
    const v = Q.mul(e.amount, value.get(e.ccy));
    nets.set(p, Q.add(nets.get(p) ?? Q.ZERO, v));
  }
  return nets;
}

// Brute-force: size of the smallest inconsistent subset (0 if none).
export function bruteForceMinConflict(rateEvents, checkFn) {
  const n = rateEvents.length;
  for (let size = 1; size <= n; size++) {
    let found = null;
    const idx = Array.from({ length: size }, (_, i) => i);
    for (;;) {
      const subset = idx.map((i) => rateEvents[i]);
      if (!checkFn(subset).ok) {
        found = subset;
        break;
      }
      let i = size - 1;
      while (i >= 0 && idx[i] === n - size + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
    }
    if (found) return { size, subset: found };
  }
  return { size: 0, subset: null };
}

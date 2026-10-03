import { toBase } from '../src/rates.js';

// Deterministic PRNG for reproducible randomized tests.
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

// Independent brute-force reference: net positions are invariant under any
// netting order, so they can be computed by plain summation.
export function bruteNetPositions(trades, rates) {
  const pos = new Map();
  for (const t of trades) {
    const w = toBase(t.amount, rates[t.ccy]);
    pos.set(t.from, (pos.get(t.from) ?? 0) - w);
    pos.set(t.to, (pos.get(t.to) ?? 0) + w);
  }
  return pos;
}

// Independent brute-force bilateral offset: for every unordered pair, sum
// both directions and keep the difference. Returns map "from->to" -> weight.
export function bruteBilateralOffsets(trades, rates) {
  const sums = new Map();
  for (const t of trades) {
    const k = t.from + '->' + t.to;
    sums.set(k, (sums.get(k) ?? 0) + toBase(t.amount, rates[t.ccy]));
  }
  const out = new Map();
  const seen = new Set();
  for (const [k, v] of sums) {
    if (seen.has(k)) continue;
    const [a, b] = k.split('->');
    const rk = b + '->' + a;
    seen.add(k);
    seen.add(rk);
    const diff = v - (sums.get(rk) ?? 0);
    if (diff > 0) out.set(k, diff);
    else if (diff < 0) out.set(rk, -diff);
  }
  return out;
}

export function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
  };
}

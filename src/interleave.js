import { shuffled } from './prng.js';

// Source priority: safety-related sources interleave first at equal timestamps.
export const SRC_PRIORITY = {
  safety: 0,
  photoeye: 1,
  cylinder: 2,
  plc: 3,
};

export function srcRank(src) {
  return SRC_PRIORITY[src] ?? 100;
}

// Canonical candidate interleaving:
//   1. order by ts
//   2. break ties by src priority, then src name
//   3. events still tied (same ts, same src tier) are shuffled with
//      reproducible randomness derived from `seed`
// The same (events, seed) always yields the same order => replayable.
export function canonicalOrder(events, seed = 0) {
  const groups = new Map();
  for (const e of events) {
    const key = `${e.ts}|${srcRank(e.src)}|${e.src}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(e);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [ta, pa, sa] = a.split('|');
    const [tb, pb, sb] = b.split('|');
    return (
      Number(ta) - Number(tb) ||
      Number(pa) - Number(pb) ||
      (sa < sb ? -1 : sa > sb ? 1 : 0)
    );
  });
  const out = [];
  keys.forEach((key, gi) => {
    out.push(...shuffled(groups.get(key), (seed >>> 0) + gi));
  });
  return out;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LimitEngine } from '../src/engine.js';
import { RefEngine } from '../src/refimpl.js';

// Deterministic PRNG so failures reproduce exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONFIG = {
  totalCap: 100,
  categoryCaps: { X: 60, Y: 80 },
  period: { origin: 0, length: 60, count: 4 }, // timeline: minutes [0, 240)
};
const CATS = ['X', 'Y'];

function randomBatch(rand, engine, idGen) {
  const size = 1 + Math.floor(rand() * 4);
  const batch = [];
  for (let i = 0; i < size; i++) {
    const roll = rand();
    const now = engine.now;
    if (roll < 0.45) {
      // freeze: new group or re-freeze of an existing active group
      const active = [...engine.groups.values()].filter((g) => g.status === 'active');
      const start = now + Math.floor(rand() * (CONFIG.period.length * CONFIG.period.count - now - 1));
      const end = start + 1 + Math.floor(rand() * Math.min(90, CONFIG.domainEnd ?? 240, 240 - start - 1) || 1);
      const clampedEnd = Math.min(end, 240);
      if (active.length && rand() < 0.3) {
        const g = active[Math.floor(rand() * active.length)];
        batch.push({ op: 'freeze', group: g.id, start, end: clampedEnd, priority: Math.floor(rand() * 3) });
      } else {
        batch.push({
          op: 'freeze',
          id: `F${idGen.n++}`,
          category: CATS[Math.floor(rand() * CATS.length)],
          amount: 1 + Math.floor(rand() * 70),
          start,
          end: clampedEnd,
          priority: Math.floor(rand() * 3),
        });
      }
    } else if (roll < 0.7) {
      const active = [...engine.groups.values()].filter((g) => g.status === 'active');
      if (!active.length) continue;
      const g = active[Math.floor(rand() * active.length)];
      const start = Math.floor(rand() * 240);
      const end = Math.min(240, start + 1 + Math.floor(rand() * 60));
      batch.push({ op: 'unfreeze', group: g.id, start, end });
    } else if (roll < 0.85) {
      const active = [...engine.groups.values()].filter((g) => g.status === 'active');
      if (!active.length) continue;
      const g = active[Math.floor(rand() * active.length)];
      batch.push({ op: 'capture', group: g.id, amount: 1 + Math.floor(rand() * 80) });
    } else {
      batch.push({ op: 'advance', now: now + Math.floor(rand() * 30) });
    }
  }
  return batch;
}

// Acceptance 4: enumerate every minute of a small timeline and cross-check
// the engine against the brute-force reference; occupancy never exceeds caps.
for (const seed of [1, 7, 42, 1337, 20261006]) {
  test(`fuzz vs reference impl, seed ${seed}: per-minute occupancy matches and never exceeds caps`, () => {
    const rand = mulberry32(seed);
    const engine = new LimitEngine(CONFIG);
    const ref = new RefEngine(CONFIG);
    const idGen = { n: 0 };
    let refSeq = 0;

    for (let round = 0; round < 120; round++) {
      const batch = randomBatch(rand, engine, idGen);
      if (!batch.length) continue;

      // Mirror the engine's deterministic arbitration order for the reference.
      const stamped = batch.map((r, i) => ({ r, seq: refSeq++, priority: r.priority ?? 0, i }));
      const order = [...stamped].sort((a, b) => b.priority - a.priority || a.seq - b.seq);

      const results = engine.submit(batch);
      assert.equal(results.length, order.length);
      for (let k = 0; k < order.length; k++) {
        const refRes = ref.apply(order[k].r);
        const engRes = results[k];
        assert.equal(
          engRes.ok,
          refRes.ok,
          `seed ${seed} round ${round} op ${JSON.stringify(order[k].r)}: engine=${JSON.stringify(engRes)} ref=${JSON.stringify(refRes)}`,
        );
        if (!engRes.ok) assert.equal(engRes.code, refRes.code);
      }

      // Enumerate every live minute: engine and reference agree, caps hold.
      // (Minutes before `now` are released by the engine's auto-expiry watermark.)
      for (let t = engine.now; t < 240; t++) {
        const occ = engine.occupancyAt(t);
        assert.equal(occ, ref.occupancyAt(t), `minute ${t} occupancy mismatch (seed ${seed})`);
        assert.ok(occ <= CONFIG.totalCap, `minute ${t}: occupancy ${occ} exceeds totalCap`);
      }
      for (const cat of CATS) {
        for (let p = 0; p < CONFIG.period.count; p++) {
          const usage = engine.categoryPeriodUsage(cat, p);
          assert.equal(usage, ref.catUsage(cat, p), `cat ${cat} period ${p} usage mismatch`);
          assert.ok(usage <= CONFIG.categoryCaps[cat], `cat ${cat} period ${p}: ${usage} exceeds cap`);
        }
      }

      // Normalized set expands back to the same per-minute occupancy.
      const norm = engine.normalized();
      for (let i = 1; i < norm.length; i++) {
        assert.ok(norm[i - 1].end <= norm[i].start, 'normalized segments are sorted and disjoint');
      }
      for (const seg of norm) {
        for (let t = seg.start; t < seg.end; t++) {
          assert.equal(engine.occupancyAt(t), seg.occupancy);
        }
      }
    }
  });
}

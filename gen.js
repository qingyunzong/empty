'use strict';

// Deterministic seeded PRNG (mulberry32).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate two offline event sources (nodes A and B) that are independently
// causally consistent. A fixed set of shared transaction ids is posted by
// both nodes; about half of them carry conflicting amounts.
function generate(seed, count) {
  const planRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const sharedCount = Math.max(2, Math.floor(count / 10));
  const sharedPlan = [];
  for (let i = 0; i < sharedCount; i++) {
    const base = 100 + Math.floor(planRng() * 900);
    const conflict = planRng() < 0.5;
    sharedPlan.push({
      id: `tx-shared-${i}`,
      amountA: base,
      amountB: conflict ? base + 1 + Math.floor(planRng() * 50) : base,
    });
  }

  const sources = {};
  for (const node of ['A', 'B']) {
    const rng = mulberry32((seed * 31 + node.charCodeAt(0)) >>> 0);
    const events = [];
    const posts = [];
    const voids = [];
    let lamport = 0;
    let sharedIdx = 0;
    for (let i = 0; i < count; i++) {
      const u = rng();
      let e;
      if (u < 0.6 || posts.length === 0) {
        let id;
        let amount;
        if (sharedIdx < sharedPlan.length && rng() < 0.4) {
          const s = sharedPlan[sharedIdx++];
          id = s.id;
          amount = node === 'A' ? s.amountA : s.amountB;
        } else {
          id = `tx-${node}-${i}`;
          amount = 1 + Math.floor(rng() * 1000);
        }
        e = { id, kind: 'post', causes: [], lamport: lamport++, node, amount };
        posts.push(e);
      } else if (u < 0.85 || voids.length === 0) {
        const target = posts[Math.floor(rng() * posts.length)];
        e = {
          id: `void-${node}-${i}`,
          kind: 'void',
          causes: [target.id],
          lamport: lamport++,
          node,
          target: target.id,
        };
        voids.push(e);
      } else {
        const target = voids[Math.floor(rng() * voids.length)];
        e = {
          id: `revive-${node}-${i}`,
          kind: 'revive',
          causes: [target.id],
          lamport: lamport++,
          node,
          target: target.id,
        };
      }
      if (events.length && rng() < 0.3) {
        const extra = events[Math.floor(rng() * events.length)];
        if (!e.causes.includes(extra.id)) e.causes.push(extra.id);
      }
      events.push(e);
    }
    sources[node.toLowerCase()] = events;
  }
  return sources;
}

function toNdjson(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

module.exports = { generate, toNdjson, mulberry32 };

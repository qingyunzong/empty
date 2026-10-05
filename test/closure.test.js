import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { analyzeEvents, reachIdx } from '../src/graph.js';

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// random DAG: random topological order, random edges among comparable pairs
function randomPoset(rand, n) {
  const ids = Array.from({ length: n }, (_, i) => 'e' + i);
  const order = shuffle(ids, rand);
  const pos = new Map(order.map((id, i) => [id, i]));
  const events = ids.map((id) => ({ id, preds: [] }));
  for (const y of ids) {
    for (const x of ids) {
      if (pos.get(x) < pos.get(y) && rand() < 0.35) events.find((e) => e.id === y).preds.push(x);
    }
  }
  return events;
}

// brute-force transitive closure: reach[y] = set of x with x <= y
function bruteClosure(events) {
  const preds = new Map(events.map((e) => [e.id, e.preds ?? []]));
  const reach = new Map(events.map((e) => [e.id, new Set()]));
  for (const e of events) {
    const seen = reach.get(e.id);
    const stack = [...preds.get(e.id)];
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p)) continue;
      seen.add(p);
      if (preds.has(p)) stack.push(...preds.get(p));
    }
  }
  return reach;
}

function toMap(events) {
  return new Map(events.map((e) => [e.id, { preds: [...(e.preds ?? [])] }]));
}

// Acceptance 4: n<=9 random posets cross-checked against brute-force closure.
test('random posets (n<=9): library closure matches brute force; closure-preserving variants are EQUAL', () => {
  const rand = mulberry32(12345);
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 9);
    const events = randomPoset(rand, n);
    const brute = bruteClosure(events);

    // 1. bitset closure matches brute force on every ordered pair
    const an = analyzeEvents(toMap(events));
    for (const y of events) {
      for (const x of events) {
        assert.equal(
          reachIdx(an, an.index.get(x.id), an.index.get(y.id)),
          brute.get(y.id).has(x.id),
          `closure mismatch at (${x.id}, ${y.id}) iter=${iter}`,
        );
      }
    }

    // 2. a shuffled copy with full-closure edges has the same canonical form
    const closed = events.map((e) => ({ id: e.id, preds: [...brute.get(e.id)].filter((x) => x !== e.id) }));
    const s = new Store();
    assert.equal(s.ingest('orig', shuffle(events, rand)).status, 'OK');
    assert.equal(s.ingest('closed', shuffle(closed, rand)).status, 'OK');
    assert.equal(s.equiv('orig', 'closed').status, 'EQUAL', `iter=${iter}`);

    // 3. drop one random edge: EQUAL if closure preserved, else UNDECIDED (nested)
    const withPreds = events.filter((e) => e.preds.length > 0);
    if (withPreds.length > 0) {
      const victim = withPreds[Math.floor(rand() * withPreds.length)];
      const dropped = victim.preds[Math.floor(rand() * victim.preds.length)];
      const reduced = events.map((e) =>
        e.id === victim.id ? { id: e.id, preds: e.preds.filter((p) => p !== dropped) } : { id: e.id, preds: [...e.preds] },
      );
      const bruteReduced = bruteClosure(reduced);
      let sameClosure = true;
      outer: for (const e of events) {
        for (const x of brute.get(e.id)) {
          if (!bruteReduced.get(e.id).has(x)) {
            sameClosure = false;
            break outer;
          }
        }
      }
      const s2 = new Store();
      s2.ingest('full', events);
      s2.ingest('reduced', reduced);
      const expected = sameClosure ? 'EQUAL' : 'UNDECIDED';
      assert.equal(s2.equiv('full', 'reduced').status, expected, `iter=${iter} drop ${dropped}->${victim.id}`);
    }

    // 4. flip one random edge: verdict must match brute-force decision rule
    if (withPreds.length > 0) {
      const victim = withPreds[Math.floor(rand() * withPreds.length)];
      const dropped = victim.preds[Math.floor(rand() * victim.preds.length)];
      const flipped = events.map((e) => ({ id: e.id, preds: e.id === victim.id ? e.preds.filter((p) => p !== dropped) : [...e.preds] }));
      flipped.find((e) => e.id === dropped).preds.push(victim.id);
      const bruteFlip = bruteClosure(flipped);
      let ab = false;
      let ba = false;
      for (const e of events) {
        for (const x of events.map((u) => u.id)) {
          const inOrig = brute.get(e.id).has(x);
          const inFlip = (bruteFlip.get(e.id) ?? new Set()).has(x);
          if (inOrig && !inFlip) ab = true;
          if (inFlip && !inOrig) ba = true;
        }
      }
      const expected = ab && ba ? 'NOT_EQUAL' : !ab && !ba ? 'EQUAL' : 'UNDECIDED';
      const s3 = new Store();
      s3.ingest('orig', events);
      s3.ingest('flipped', flipped);
      const r = s3.equiv('orig', 'flipped');
      assert.equal(r.status, expected, `iter=${iter} flip ${dropped}<->${victim.id}`);
      if (expected === 'NOT_EQUAL') {
        assert.ok(r.first_divergent && Array.isArray(r.minimal_frontier));
      }
      if (expected === 'UNDECIDED') {
        assert.ok(Array.isArray(r.missing_edges));
      }
    }
  }
});

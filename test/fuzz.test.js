// Acceptance 4: random partial orders (n <= 9) cross-checked against an
// independent brute-force transitive-closure normalization.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLogs } from '../src/compare.js';

// --- independent brute-force reference implementation ---

function bruteAncestors(events) {
  // id -> Set of ancestor ids, computed by naive fixpoint.
  const causes = new Map(events.map((e) => [e.id, e.causes.filter((c) => causes0has(events, c))]));
  function causes0has(evts, c) {
    return evts.some((e) => e.id === c);
  }
  const anc = new Map(events.map((e) => [e.id, new Set()]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of events) {
      for (const c of causes.get(e.id)) {
        if (!anc.get(e.id).has(c)) {
          anc.get(e.id).add(c);
          changed = true;
        }
        for (const a of anc.get(c)) {
          if (!anc.get(e.id).has(a)) {
            anc.get(e.id).add(a);
            changed = true;
          }
        }
      }
    }
  }
  return anc;
}

function bruteCompare(eventsA, eventsB) {
  const ancA = bruteAncestors(eventsA);
  const ancB = bruteAncestors(eventsB);
  const setA = new Set(eventsA.map((e) => e.id));
  const setB = new Set(eventsB.map((e) => e.id));
  const shared = [...setA].filter((id) => setB.has(id));
  let aBeyondB = false;
  let bBeyondA = false;
  for (const v of shared) {
    for (const u of shared) {
      if (u === v) continue;
      const inA = ancA.get(v).has(u);
      const inB = ancB.get(v).has(u);
      if (inA && !inB) aBeyondB = true;
      if (inB && !inA) bBeyondA = true;
    }
  }
  const danglingA = eventsA.some((e) => e.causes.some((c) => !setA.has(c)));
  const danglingB = eventsB.some((e) => e.causes.some((c) => !setB.has(c)));
  const hasMissing =
    setA.size !== setB.size ||
    [...setA].some((id) => !setB.has(id)) ||
    danglingA ||
    danglingB ||
    aBeyondB !== bBeyondA;
  if (aBeyondB && bBeyondA) return 'NOT_EQUAL';
  if (hasMissing) return 'UNDECIDED';
  return 'EQUAL';
}

// --- random generators (seeded, deterministic) ---

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPosetLogs(rand) {
  const n = 1 + Math.floor(rand() * 9); // 1..9 events
  const ids = [];
  for (let i = 0; i < n; i++) ids.push('e' + i);
  // random topological order
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  // random DAG edges (respecting the order), possibly with cycles injected
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < 0.35) edges.push([order[i], order[j]]);
    }
  }
  if (rand() < 0.3 && n >= 2) {
    // inject a cycle: reverse one edge
    const k = Math.floor(rand() * edges.length);
    if (edges[k]) edges[k] = [edges[k][1], edges[k][0]];
  }
  const mkLog = (keepProb, dropEventProb, extraDangling) => {
    const evts = [];
    for (const id of ids) {
      if (rand() < dropEventProb) continue;
      const causes = edges
        .filter(([u, v]) => v === id && rand() < keepProb)
        .map(([u]) => u);
      if (extraDangling && rand() < 0.2) causes.push('ghost' + Math.floor(rand() * 3));
      evts.push({ id, causes });
    }
    // shuffle record order
    for (let i = evts.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [evts[i], evts[j]] = [evts[j], evts[i]];
    }
    return evts;
  };
  // Both logs sample the edge pool independently, so each may imply causal
  // pairs the other lacks (genuine conflicts) as well as mere gaps.
  return [mkLog(0.85, 0.05, false), mkLog(0.85, 0.05, true)];
}

test('random posets (n<=9): library matches brute-force closure rule', () => {
  const rand = mulberry32(20261004);
  const tally = { EQUAL: 0, NOT_EQUAL: 0, UNDECIDED: 0 };
  for (let iter = 0; iter < 500; iter++) {
    const [a, b] = randomPosetLogs(rand);
    const expected = bruteCompare(a, b);
    const actual = compareLogs(a, b).status;
    tally[actual]++;
    assert.equal(actual, expected, `iter ${iter}: ${JSON.stringify({ a, b })}`);
  }
  // sanity: all three outcomes were exercised
  assert.ok(tally.EQUAL > 0, JSON.stringify(tally));
  assert.ok(tally.UNDECIDED > 0, JSON.stringify(tally));
  assert.ok(tally.NOT_EQUAL > 0, JSON.stringify(tally));
});

test('same closure, different direct edges -> EQUAL (brute-force verified)', () => {
  const rand = mulberry32(777);
  for (let iter = 0; iter < 200; iter++) {
    const n = 2 + Math.floor(rand() * 8);
    const ids = Array.from({ length: n }, (_, i) => 'e' + i);
    // random DAG in id order
    const edges = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.4) edges.push([ids[i], ids[j]]);
      }
    }
    // log A: all edges; log B: brute-force transitive reduction of the same DAG
    const anc = new Map(ids.map((id) => [id, new Set()]));
    for (let k = 0; k < n; k++) {
      for (const [u, v] of edges) {
        anc.get(v).add(u);
        for (const a of anc.get(u)) anc.get(v).add(a);
      }
    }
    const reduced = edges.filter(([u, v]) => {
      // edge u->v is redundant if v reachable from u without this edge
      const others = edges.filter(([a, b]) => !(a === u && b === v));
      const seen = new Set([u]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [a, b] of others) {
          if (seen.has(a) && !seen.has(b)) {
            seen.add(b);
            grew = true;
          }
        }
      }
      return !seen.has(v);
    });
    const a = ids.map((id) => ({ id, causes: edges.filter(([, v]) => v === id).map(([u]) => u) }));
    const b = ids.map((id) => ({ id, causes: reduced.filter(([, v]) => v === id).map(([u]) => u) }));
    assert.equal(bruteCompare(a, b), 'EQUAL');
    assert.equal(compareLogs(a, b).status, 'EQUAL', `iter ${iter}`);
  }
});

test('first_divergent and minimal_frontier are consistent with brute force', () => {
  const rand = mulberry32(42);
  let checked = 0;
  for (let iter = 0; iter < 500 && checked < 50; iter++) {
    const [a, b] = randomPosetLogs(rand);
    const r = compareLogs(a, b);
    if (r.status !== 'NOT_EQUAL') continue;
    checked++;
    // first_divergent: verify against brute-force ancestor sets
    const ancA = bruteAncestors(a);
    const ancB = bruteAncestors(b);
    const setB = new Set(b.map((e) => e.id));
    const shared = a.map((e) => e.id).filter((id) => setB.has(id)).sort();
    let expectedFirst = null;
    for (const v of shared) {
      let differs = false;
      for (const u of shared) {
        if (u === v) continue;
        if (ancA.get(v).has(u) !== ancB.get(v).has(u)) {
          differs = true;
          break;
        }
      }
      if (differs) {
        expectedFirst = v;
        break;
      }
    }
    assert.equal(r.first_divergent, expectedFirst, `iter ${iter}`);
    // minimal_frontier: non-empty, every edge is a genuine difference
    assert.ok(r.minimal_frontier.length > 0);
    for (const e of r.minimal_frontier) {
      const inA = ancA.get(e.to)?.has(e.from) ?? false;
      const inB = ancB.get(e.to)?.has(e.from) ?? false;
      assert.notEqual(inA, inB, `frontier edge must differ: ${JSON.stringify(e)}`);
    }
  }
  assert.ok(checked > 0, 'expected at least one NOT_EQUAL case');
});

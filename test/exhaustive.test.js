'use strict';

/**
 * Acceptance 3: exhaustive cross-check on all graphs up to n <= 8.
 *
 * For random small graphs (with random closures and reweights) every ordered
 * pair query is compared against a brute-force enumeration of all simple
 * paths: identical minimum cost, identical lexicographically smallest path,
 * and every issued certificate must verify.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgvGraph, ERR } from '../src/index.js';

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brute force: min cost and lexicographically smallest min-cost path. */
function bruteForce(nodes, edges, src, dst) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) {
    if (e.closed) continue;
    adj.get(e.a).push({ to: e.b, w: e.cost });
    adj.get(e.b).push({ to: e.a, w: e.cost });
  }
  let bestCost = Infinity;
  let bestPath = null;
  const stack = [[src, 0, [src]]];
  while (stack.length > 0) {
    const [u, c, p] = stack.pop();
    if (c > bestCost) continue;
    if (u === dst) {
      if (c < bestCost) {
        bestCost = c;
        bestPath = p;
      } else if (c === bestCost) {
        // lexicographic compare on string ids
        let i = 0;
        while (i < p.length && i < bestPath.length && p[i] === bestPath[i]) i++;
        const smaller =
          i < p.length && i < bestPath.length ? p[i] < bestPath[i] : p.length < bestPath.length;
        if (smaller) bestPath = p;
      }
      continue;
    }
    for (const { to, w } of adj.get(u)) {
      if (!p.includes(to)) stack.push([to, c + w, [...p, to]]);
    }
  }
  return bestPath === null ? null : { cost: bestCost, path: bestPath };
}

function randomInstance(seed) {
  const rand = rng(seed);
  const n = 2 + Math.floor(rand() * 7); // 2..8 nodes
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const g = new AgvGraph();
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([nodes[i], nodes[j]]);
  // Shuffle pairs, take a random subset.
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const m = Math.min(pairs.length, Math.floor(rand() * (pairs.length + 1)));
  for (let i = 0; i < m; i++) {
    const [a, b] = pairs[i];
    assert.equal(g.addEdge(a, b, 1 + Math.floor(rand() * 9)).ok, true);
  }
  // Random dynamic operations: close / open / set_cost / undo.
  const edgeList = () => [...g.edges.values()];
  const ops = 3 + Math.floor(rand() * 6);
  for (let k = 0; k < ops; k++) {
    const es = edgeList();
    if (es.length === 0) break;
    const e = es[Math.floor(rand() * es.length)];
    const roll = rand();
    if (roll < 0.35) g[e.closed ? 'openEdge' : 'closeEdge'](e.a, e.b);
    else if (roll < 0.7) g.setCost(e.a, e.b, 1 + Math.floor(rand() * 9));
    else if (roll < 0.8) g.undo();
    else g.addEdge; // no-op slot keeps distribution simple
  }
  return { g, nodes };
}

test('acceptance 3: all-pairs queries match brute-force enumeration (n<=8)', () => {
  const SEEDS = 40;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { g, nodes } = randomInstance(seed);
    const openEdges = [...g.edges.values()];
    for (const s of nodes) {
      for (const t of nodes) {
        const bf = bruteForce(nodes, openEdges, s, t);
        const r = g.query(s, t);
        if (bf === null) {
          assert.equal(r.ok, false, `seed ${seed} ${s}->${t} should be NO_PATH`);
          assert.equal(r.error, ERR.NO_PATH);
          assert.equal(g.verify(r.cert).ok, true, `seed ${seed} nopath cert`);
        } else {
          assert.equal(r.ok, true, `seed ${seed} ${s}->${t} should be reachable`);
          assert.equal(r.cost, bf.cost, `seed ${seed} ${s}->${t} cost`);
          assert.deepEqual(r.path, bf.path, `seed ${seed} ${s}->${t} lex path`);
          assert.equal(g.verify(r.cert).ok, true, `seed ${seed} cert`);
        }
      }
    }
  }
});

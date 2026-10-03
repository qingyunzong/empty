import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCycles } from '../src/graph.js';
import { computeCertificates } from '../src/engine.js';

// Independent brute-force cycle enumerator: tries every permutation of every
// node subset of size >= 2 and keeps those forming a directed cycle.
function bruteForceCycles(nodes, hasEdge) {
  const out = new Set();
  const sorted = [...nodes].sort();
  const used = new Array(sorted.length).fill(false);
  const path = [];
  const visit = () => {
    if (path.length >= 2) {
      const last = path[path.length - 1];
      if (hasEdge(last, path[0])) {
        // Canonical rotation: start at the lexicographically smallest node.
        let minIdx = 0;
        for (let i = 1; i < path.length; i++) if (path[i] < path[minIdx]) minIdx = i;
        const canon = path.slice(minIdx).concat(path.slice(0, minIdx));
        out.add(canon.join('>'));
      }
    }
    if (path.length === sorted.length) return;
    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      if (path.length > 0 && !hasEdge(path[path.length - 1], sorted[i])) continue;
      used[i] = true;
      path.push(sorted[i]);
      visit();
      path.pop();
      used[i] = false;
    }
  };
  visit();
  return out;
}

function canonSet(cycles) {
  return new Set(cycles.map((c) => c.join('>')));
}

// Enumerate ALL directed graphs (no self loops) on n=2,3,4 nodes and compare
// findCycles against the brute-force enumerator. 2^(n*(n-1)) graphs per n.
for (const n of [2, 3, 4]) {
  test(`exhaustive cross-check of cycle enumeration for all digraphs on ${n} nodes`, () => {
    const nodes = ['A', 'B', 'C', 'D'].slice(0, n);
    const pairs = [];
    for (const u of nodes) for (const v of nodes) if (u !== v) pairs.push([u, v]);
    const total = 1 << pairs.length;
    for (let mask = 0; mask < total; mask++) {
      const adj = new Map(nodes.map((x) => [x, []]));
      const edgeSet = new Set();
      pairs.forEach(([u, v], i) => {
        if (mask & (1 << i)) {
          adj.get(u).push(v);
          edgeSet.add(`${u} ${v}`);
        }
      });
      const expected = bruteForceCycles(nodes, (a, b) => edgeSet.has(`${a} ${b}`));
      const actual = canonSet(findCycles(adj));
      assert.deepEqual(actual, expected, `mismatch for mask=${mask.toString(2)}`);
    }
  });
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random interval-overlap cross-check: certificates from computeCertificates
// must match per-segment brute-force cycles of the active wait graph.
test('interval overlap certificates match brute-force cycles at every segment', () => {
  const rnd = mulberry32(20261003);
  const agvs = ['A', 'B', 'C', 'D'];
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rnd() * 3); // 2..4 agvs
    const nodes = agvs.slice(0, n);
    const instances = [];
    const count = 1 + Math.floor(rnd() * 7);
    for (let i = 0; i < count; i++) {
      const from = nodes[Math.floor(rnd() * n)];
      let to = nodes[Math.floor(rnd() * n)];
      if (to === from) to = nodes[(nodes.indexOf(from) + 1) % n];
      const start = Math.floor(rnd() * 20);
      const end = rnd() < 0.25 ? Infinity : start + 1 + Math.floor(rnd() * 10);
      instances.push({ from, to, start, end, reserveId: `r${i}`, pingId: `p${i}` });
    }
    const certs = computeCertificates(instances);

    // Rebuild elementary segments independently.
    const ptSet = new Set();
    for (const i of instances) {
      ptSet.add(i.start);
      if (i.end !== Infinity) ptSet.add(i.end);
    }
    const pts = [...ptSet].sort((a, b) => a - b);
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
    if (instances.some((i) => i.end === Infinity)) segs.push([pts[pts.length - 1], Infinity]);

    for (const [s, t] of segs) {
      const active = instances.filter((i) => i.start <= s && i.end >= t);
      const edgeSet = new Set(active.map((i) => `${i.from} ${i.to}`));
      const expected = bruteForceCycles(nodes, (a, b) => edgeSet.has(`${a} ${b}`));
      const actual = new Set(
        certs
          .filter(
            (c) => c.interval[0] <= s && (c.interval[1] === null || c.interval[1] >= t)
          )
          .map((c) => c.cycle.join('>'))
      );
      assert.deepEqual(actual, expected, `trial=${trial} segment=[${s},${t})`);
    }

    // Cert intervals must align to segment boundaries and never overlap.
    const covered = [];
    for (const c of certs) {
      assert.ok(pts.includes(c.interval[0]), `trial=${trial} cert start aligned`);
      assert.ok(c.interval[1] === null || pts.includes(c.interval[1]), `trial=${trial} cert end aligned`);
      covered.push([c.interval[0], c.interval[1] === null ? Infinity : c.interval[1], c.cycle.join('>')]);
    }
    for (let i = 0; i < covered.length; i++) {
      for (let j = i + 1; j < covered.length; j++) {
        if (covered[i][2] !== covered[j][2]) continue;
        const overlap = Math.min(covered[i][1], covered[j][1]) > Math.max(covered[i][0], covered[j][0]);
        assert.ok(!overlap, `trial=${trial} same-cycle certs do not overlap in time`);
      }
    }
  }
});

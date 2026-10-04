'use strict';

// Exhaustive cross-check: enumerate every edge subset over <= 4 lots and
// validate the library's DAG / reachability logic against an independent
// DFS implementation written here. Then exhaustively (n <= 3) and by
// seeded sampling (n = 4) verify three-way merge decisions and cycle
// detection against an independent re-implementation of the merge rules.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDag, reachable, mergeGraphs } = require('../lib/genealogy');

// ---------- independent reference implementations (test-local) ----------

function refHasCycle(n, pairs) {
  const adj = Array.from({ length: n }, () => []);
  for (const [c, p] of pairs) adj[c].push(p);
  const state = new Array(n).fill(0);
  function visit(u) {
    state[u] = 1;
    for (const v of adj[u]) {
      if (state[v] === 1) return true;
      if (state[v] === 0 && visit(v)) return true;
    }
    state[u] = 2;
    return false;
  }
  for (let i = 0; i < n; i += 1) {
    if (state[i] === 0 && visit(i)) return true;
  }
  return false;
}

function refReachable(n, pairs, src) {
  const adj = Array.from({ length: n }, () => []);
  for (const [c, p] of pairs) adj[c].push(p);
  const seen = new Set();
  const stack = [...adj[src]];
  while (stack.length > 0) {
    const u = stack.pop();
    if (seen.has(u)) continue;
    seen.add(u);
    for (const v of adj[u]) stack.push(v);
  }
  return seen;
}

// Independent re-implementation of the per-edge three-way decision table.
function refDecide(b, l, r) {
  if (l === r) return { take: l };
  if (b === l) return { take: r };
  if (b === r) return { take: l };
  return { conflict: true };
}

// ---------- helpers ----------

function allDirectedPairs(n) {
  const pairs = [];
  for (let c = 0; c < n; c += 1) {
    for (let p = 0; p < n; p += 1) {
      if (c !== p) pairs.push([c, p]);
    }
  }
  return pairs;
}

function buildGraph(n, pairsWithRelation) {
  const lots = new Set();
  for (let i = 0; i < n; i += 1) lots.add(`L${i}`);
  const edges = new Map();
  for (const [c, p, relation] of pairsWithRelation) {
    edges.set(`L${c} L${p}`, relation);
  }
  return { lots, edges };
}

function plainEdgeSet(plain) {
  return new Set(plain.edges.map((e) => `${e.child} ${e.parent} ${e.relation}`));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- DAG / reachability cross-check over all subsets, n <= 4 ----------

test('exhaustive: isDag and reachable match independent DFS for every edge subset, n <= 4', () => {
  let checked = 0;
  for (let n = 1; n <= 4; n += 1) {
    const pairs = allDirectedPairs(n);
    const total = 1 << pairs.length; // max 2^12 = 4096 for n = 4
    for (let mask = 0; mask < total; mask += 1) {
      const chosen = [];
      for (let bit = 0; bit < pairs.length; bit += 1) {
        if (mask & (1 << bit)) chosen.push(pairs[bit]);
      }
      const graph = buildGraph(n, chosen.map(([c, p], idx) => [c, p, `r${idx % 2}`]));
      assert.equal(
        isDag(graph),
        !refHasCycle(n, chosen),
        `isDag mismatch for n=${n} mask=${mask}`,
      );
      for (let src = 0; src < n; src += 1) {
        const expected = new Set([...refReachable(n, chosen, src)].map((i) => `L${i}`));
        assert.deepEqual(
          reachable(graph, `L${src}`),
          expected,
          `reachability mismatch for n=${n} mask=${mask} src=${src}`,
        );
      }
      checked += 1;
    }
  }
  assert.equal(checked, 1 + 4 + 64 + 4096);
});

// ---------- three-way merge cross-check ----------

// graphs: array of normalized graphs (all sharing the same lots).
// states: array per graph of relation-or-null per edge slot.
// slots: [[c, p], ...] edge slots.
function checkMergeTriples(n, slots, graphs, states, label) {
  const lots = [...graphs[0].lots].sort();
  for (let bi = 0; bi < graphs.length; bi += 1) {
    for (let li = 0; li < graphs.length; li += 1) {
      for (let ri = 0; ri < graphs.length; ri += 1) {
        const result = mergeGraphs(graphs[bi], graphs[li], graphs[ri]);

        // lots never change in these scenarios
        assert.deepEqual(result.merged.lots, lots);

        // independent per-edge decision
        const expectedConflicts = new Set();
        const expectedEdges = new Set();
        for (let s = 0; s < slots.length; s += 1) {
          const b = states[bi][s];
          const l = states[li][s];
          const r = states[ri][s];
          const decision = refDecide(b, l, r);
          const key = `L${slots[s][0]} L${slots[s][1]}`;
          if (decision.conflict) {
            expectedConflicts.add(key);
          } else if (decision.take !== null) {
            expectedEdges.add(`${key} ${decision.take}`);
          }
        }

        const edgeConflicts = result.conflicts.filter((c) => c.type === 'edge');
        assert.deepEqual(
          new Set(edgeConflicts.map((c) => `${c.child} ${c.parent}`)),
          expectedConflicts,
          `${label}: edge conflict set mismatch for triple (${bi},${li},${ri})`,
        );
        for (const c of result.conflicts) {
          assert.ok(
            c.type === 'edge' || c.type === 'cycle',
            `${label}: unexpected conflict type ${c.type}`,
          );
        }

        if (expectedConflicts.size === 0) {
          const expectedPairs = [...expectedEdges].map((entry) => {
            const [child, parent] = entry.split(' ');
            return [Number(child.slice(1)), Number(parent.slice(1))];
          });
          if (refHasCycle(n, expectedPairs)) {
            const cycles = result.conflicts.filter((c) => c.type === 'cycle');
            assert.equal(cycles.length, 1, `${label}: expected a cycle conflict (${bi},${li},${ri})`);
            const path = cycles[0].path;
            assert.equal(path[0], path[path.length - 1]);
          } else {
            assert.deepEqual(
              result.conflicts,
              [],
              `${label}: expected clean merge (${bi},${li},${ri})`,
            );
            assert.deepEqual(
              plainEdgeSet(result.merged),
              expectedEdges,
              `${label}: merged edges mismatch (${bi},${li},${ri})`,
            );
          }
        }
      }
    }
  }
}

test('exhaustive merge: n=2, relations {a,b}, all acyclic graph triples', () => {
  const n = 2;
  const slots = allDirectedPairs(n); // [[0,1],[1,0]]
  const relationOf = ['a', 'b'];
  const graphs = [];
  const states = [];
  for (let s0 = 0; s0 < 3; s0 += 1) {
    for (let s1 = 0; s1 < 3; s1 += 1) {
      const state = [s0, s1];
      const pairs = slots.filter((_, i) => state[i] !== 0);
      if (refHasCycle(n, pairs)) continue;
      states.push(state.map((s) => (s === 0 ? null : relationOf[s - 1])));
      const edgeTriples = [];
      for (let i = 0; i < slots.length; i += 1) {
        if (state[i] !== 0) edgeTriples.push([slots[i][0], slots[i][1], relationOf[state[i] - 1]]);
      }
      graphs.push(buildGraph(n, edgeTriples));
    }
  }
  assert.equal(graphs.length, 5); // 9 combos minus 4 two-cycle combos
  checkMergeTriples(n, slots, graphs, states, 'n=2');
});

test('exhaustive merge: n=3, single relation, all 25 acyclic graphs cubed', () => {
  const n = 3;
  const slots = allDirectedPairs(n); // 6 slots
  const graphs = [];
  const states = [];
  for (let mask = 0; mask < (1 << slots.length); mask += 1) {
    const pairs = slots.filter((_, bit) => mask & (1 << bit));
    if (refHasCycle(n, pairs)) continue;
    states.push(slots.map((_, bit) => (mask & (1 << bit) ? 'a' : null)));
    graphs.push(buildGraph(n, pairs.map(([c, p]) => [c, p, 'a'])));
  }
  assert.equal(graphs.length, 25); // labeled DAGs on 3 nodes
  checkMergeTriples(n, slots, graphs, states, 'n=3');
});

test('sampled merge: n=4, single relation, 4000 seeded random acyclic triples', () => {
  const n = 4;
  const slots = allDirectedPairs(n); // 12 slots
  const graphs = [];
  const states = [];
  for (let mask = 0; mask < (1 << slots.length); mask += 1) {
    const pairs = slots.filter((_, bit) => mask & (1 << bit));
    if (refHasCycle(n, pairs)) continue;
    states.push(slots.map((_, bit) => (mask & (1 << bit) ? 'a' : null)));
    graphs.push(buildGraph(n, pairs.map(([c, p]) => [c, p, 'a'])));
  }
  assert.equal(graphs.length, 543); // labeled DAGs on 4 nodes
  const rand = mulberry32(20261004);
  const pickedG = [];
  const pickedS = [];
  const triples = [];
  for (let t = 0; t < 4000; t += 1) {
    triples.push([
      Math.floor(rand() * graphs.length),
      Math.floor(rand() * graphs.length),
      Math.floor(rand() * graphs.length),
    ]);
  }
  for (const i of new Set(triples.flat())) {
    pickedG.push(graphs[i]);
    pickedS.push(states[i]);
  }
  const indexOf = new Map([...new Set(triples.flat())].map((g, i) => [g, i]));
  const lots = [...graphs[0].lots].sort();
  for (const [bi0, li0, ri0] of triples) {
    const bi = indexOf.get(bi0);
    const li = indexOf.get(li0);
    const ri = indexOf.get(ri0);
    const result = mergeGraphs(pickedG[bi], pickedG[li], pickedG[ri]);
    assert.deepEqual(result.merged.lots, lots);
    const expectedConflicts = new Set();
    const expectedEdges = new Set();
    for (let s = 0; s < slots.length; s += 1) {
      const decision = refDecide(pickedS[bi][s], pickedS[li][s], pickedS[ri][s]);
      const key = `L${slots[s][0]} L${slots[s][1]}`;
      if (decision.conflict) expectedConflicts.add(key);
      else if (decision.take !== null) expectedEdges.add(`${key} ${decision.take}`);
    }
    const edgeConflicts = result.conflicts.filter((c) => c.type === 'edge');
    assert.deepEqual(new Set(edgeConflicts.map((c) => `${c.child} ${c.parent}`)), expectedConflicts);
    if (expectedConflicts.size === 0) {
      const expectedPairs = [...expectedEdges].map((entry) => {
        const [child, parent] = entry.split(' ');
        return [Number(child.slice(1)), Number(parent.slice(1))];
      });
      if (refHasCycle(n, expectedPairs)) {
        assert.equal(result.conflicts.filter((c) => c.type === 'cycle').length, 1);
      } else {
        assert.deepEqual(result.conflicts, []);
        assert.deepEqual(plainEdgeSet(result.merged), expectedEdges);
      }
    }
  }
});

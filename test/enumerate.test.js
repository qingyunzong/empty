'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGraph, toNFA } = require('../src/genealogy');
const {
  ALPHABET,
  determinize,
  minimize,
  reachableClosureNFA,
  reachableClosureDFA,
} = require('../src/dfa');

// Acceptance 4: exhaustive enumeration of genealogies with <= 6 batches,
// checked against the reachable defect closure. For every enumerated
// genealogy we assert:
//   (a) determinize+minimize preserves the reachable defect closure, and
//   (b) every batch (including pending ones) survives in some DFA state.

const checkGenealogy = (records) => {
  const graph = buildGraph(records);
  const nfa = toNFA(graph);
  const dfa = determinize(nfa);
  const min = minimize(dfa);
  assert.deepEqual(
    reachableClosureDFA(dfa),
    reachableClosureNFA(nfa),
    `closure changed by determinization: ${JSON.stringify(records)}`
  );
  // Minimization merges equivalent views but must keep the closure too:
  // every defect output of the DFA appears in some minimized class.
  const minOutputs = new Set([...min.states.values()].flatMap((s) => s.output));
  for (const d of reachableClosureDFA(dfa)) {
    assert.ok(minOutputs.has(d), `defect ${d} lost in minimization`);
  }
  // No batch is dropped (pending states are not unsatisfiable).
  const survivors = new Set([...dfa.states.values()].flatMap((s) => s.members));
  for (const id of graph.keys()) {
    assert.ok(survivors.has(id), `batch ${id} dropped from the view`);
  }
};

// All DAG shapes on n labelled nodes: node j's parents are a subset of
// {0..j-1}; op and status assigned deterministically per node.
const enumerateShapes = (n) => {
  const edges = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < j; i++) edges.push([i, j]);
  const total = 2 ** edges.length;
  let checked = 0;
  for (let mask = 0; mask < total; mask++) {
    const parents = Array.from({ length: n }, () => []);
    edges.forEach(([i, j], bit) => {
      if (mask & (1 << bit)) parents[j].push(`b${i}`);
    });
    const records = parents.map((p, j) =>
      p.length === 0
        ? { batch: `b${j}`, defects: [`d${j}`], status: j % 3 === 0 ? 'pending' : 'ok' }
        : {
            batch: `b${j}`,
            op: ALPHABET[j % 4],
            parents: p,
            defects: [`d${j}`],
            status: j % 3 === 0 ? 'pending' : 'ok',
          }
    );
    checkGenealogy(records);
    checked++;
  }
  return checked;
};

test('exhaustive: all DAG shapes on <= 5 batches preserve the defect closure', () => {
  let checked = 0;
  for (let n = 1; n <= 5; n++) checked += enumerateShapes(n);
  assert.equal(checked, 1 + 2 + 8 + 64 + 1024);
});

test('exhaustive: all 32768 DAG shapes on 6 batches preserve the defect closure', () => {
  assert.equal(enumerateShapes(6), 32768);
});

// Seeded fuzz on 6 batches with shared defect pools (defects overlap across
// batches, so union semantics is actually exercised) and random ops.
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('fuzz: 500 random 6-batch genealogies with shared defects', () => {
  const rand = mulberry32(20261007);
  const pool = ['d0', 'd1', 'd2', 'd3'];
  for (let iter = 0; iter < 500; iter++) {
    const records = [];
    for (let j = 0; j < 6; j++) {
      const parents = [];
      for (let i = 0; i < j; i++) if (rand() < 0.4) parents.push(`b${i}`);
      const defects = pool.filter(() => rand() < 0.4);
      records.push(
        parents.length === 0
          ? { batch: `b${j}`, defects, status: rand() < 0.3 ? 'pending' : 'ok' }
          : {
              batch: `b${j}`,
              op: ALPHABET[Math.floor(rand() * 4)],
              parents,
              defects,
              status: rand() < 0.3 ? 'pending' : 'ok',
            }
      );
    }
    checkGenealogy(records);
  }
});

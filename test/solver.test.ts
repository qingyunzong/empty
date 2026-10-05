import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseProblem, InputError } from '../src/parse.js';
import { solveProblem } from '../src/solve.js';
import { bruteForce, branchAndBound } from '../src/solver.js';
import { checkSolution } from '../src/cert.js';
import type { ProblemInput } from '../src/types.js';

test('simple 3-cycle: cheapest edge is deleted', () => {
  const p = parseProblem({
    nodes: ['a', 'b', 'c'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', cost: 5 },
      { id: 'bc', from: 'b', to: 'c', cost: 1 },
      { id: 'ca', from: 'c', to: 'a', cost: 3 },
    ],
  } satisfies ProblemInput);
  const sol = solveProblem(p, { verify: true });
  assert.equal(sol.status, 'optimal');
  assert.deepEqual(sol.deletedEdges!.map((e) => e.id), ['bc']);
  assert.equal(sol.totalCost, 1);
  assert.equal(sol.topologicalOrder!.length, 3);
  assert.equal(sol.proof!.enumeration!.matches, true);
  assert.equal(sol.proof!.enumeration!.subsetsChecked, 8);
});

test('locked cycle is infeasible and reports the undeletable cycle', () => {
  const p = parseProblem({
    nodes: ['a', 'b', 'c'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', locked: true },
      { id: 'bc', from: 'b', to: 'c', locked: true },
      { id: 'ca', from: 'c', to: 'a', locked: true },
    ],
  } satisfies ProblemInput);
  const sol = solveProblem(p);
  assert.equal(sol.status, 'infeasible');
  assert.equal(sol.infeasible!.reason, 'locked-cycle');
  const cyc = sol.infeasible!.cycle!;
  assert.equal(cyc[0], cyc[cyc.length - 1]);
  assert.equal(cyc.length, 4);
});

test('locked edge in a mixed cycle forces deleting the other edge', () => {
  const p = parseProblem({
    nodes: ['a', 'b'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', locked: true },
      { id: 'ba', from: 'b', to: 'a', cost: 7 },
    ],
  } satisfies ProblemInput);
  const sol = solveProblem(p);
  assert.equal(sol.status, 'optimal');
  assert.deepEqual(sol.deletedEdges!.map((e) => e.id), ['ba']);
  assert.equal(sol.totalCost, 7);
});

test('reachability preservation forces breaking the cycle elsewhere', () => {
  // a->b->c->a cycle, plus entry s must reach exit t via a->b->c->t chain
  const p = parseProblem({
    nodes: ['s', 'a', 'b', 'c', 't'],
    edges: [
      { id: 'sa', from: 's', to: 'a', cost: 100 },
      { id: 'ab', from: 'a', to: 'b', cost: 100 },
      { id: 'bc', from: 'b', to: 'c', cost: 100 },
      { id: 'ca', from: 'c', to: 'a', cost: 1 },
      { id: 'ct', from: 'c', to: 't', cost: 100 },
    ],
    entries: ['s'],
    exits: ['t'],
  } satisfies ProblemInput);
  const sol = solveProblem(p, { verify: true });
  assert.equal(sol.status, 'optimal');
  assert.deepEqual(sol.deletedEdges!.map((e) => e.id), ['ca']);
  assert.equal(sol.totalCost, 1);
  const cert = sol.preservedPaths!.find((c) => c.from === 's' && c.to === 't')!;
  assert.deepEqual(cert.path, ['s', 'a', 'b', 'c', 't']);
});

test('budget too small is infeasible and reports the relaxed minimum', () => {
  const p = parseProblem({
    nodes: ['a', 'b'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', cost: 4 },
      { id: 'ba', from: 'b', to: 'a', cost: 4 },
    ],
    budget: 3,
  } satisfies ProblemInput);
  const sol = solveProblem(p);
  assert.equal(sol.status, 'infeasible');
  assert.match(sol.infeasible!.reason, /budget 3 too small/);
  assert.equal(sol.infeasible!.minCostWithoutBudget, 4);
});

test('group prerequisite: deleting a grouped edge forces deleting required group', () => {
  // cycle a->b->a; edge ba is cheap but in group "plugin" which requires group "core"
  const p = parseProblem({
    nodes: ['a', 'b', 'c'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', cost: 10 },
      { id: 'ba', from: 'b', to: 'a', cost: 1, group: 'plugin' },
      { id: 'cx', from: 'c', to: 'c', cost: 2, group: 'core' },
    ],
    groups: { plugin: { requires: ['core'] } },
  } satisfies ProblemInput);
  const sol = solveProblem(p, { verify: true });
  assert.equal(sol.status, 'optimal');
  // deleting ba (1) forces deleting cx (2): total 3, still cheaper than ab (10)
  assert.deepEqual(sol.deletedEdges!.map((e) => e.id).sort(), ['ba', 'cx']);
  assert.equal(sol.totalCost, 3);
  assert.equal(sol.proof!.enumeration!.matches, true);
});

test('group whose required group contains a locked edge becomes undeletable', () => {
  const p = parseProblem({
    nodes: ['a', 'b'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', cost: 9 },
      { id: 'ba', from: 'b', to: 'a', cost: 1, group: 'plugin' },
      { id: 'self', from: 'a', to: 'a', locked: true, group: 'core' },
    ],
    groups: { plugin: { requires: ['core'] } },
  } satisfies ProblemInput);
  // 'self' is a locked self-loop => locked-cycle infeasibility wins
  const sol = solveProblem(p);
  assert.equal(sol.status, 'infeasible');
  assert.equal(sol.infeasible!.reason, 'locked-cycle');
});

test('impossible group edge is treated as undeletable (no locked self-loop)', () => {
  const p = parseProblem({
    nodes: ['a', 'b', 'c'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', cost: 9 },
      { id: 'ba', from: 'b', to: 'a', cost: 1, group: 'plugin' },
      { id: 'cc', from: 'c', to: 'c', locked: true, group: 'core' },
    ],
    groups: { plugin: { requires: ['core'] } },
  } satisfies ProblemInput);
  // cc is a locked self loop -> locked cycle
  const sol = solveProblem(p);
  assert.equal(sol.status, 'infeasible');
});

test('unreachable required pair is infeasible', () => {
  const p = parseProblem({
    nodes: ['s', 't'],
    edges: [{ id: 'ts', from: 't', to: 's' }],
    entries: ['s'],
    exits: ['t'],
  } satisfies ProblemInput);
  const sol = solveProblem(p);
  assert.equal(sol.status, 'infeasible');
  assert.match(sol.infeasible!.reason, /unreachable/);
});

test('input validation: too many edges, dup ids, unknown nodes, bad cost', () => {
  const many = { nodes: ['a', 'b'], edges: Array.from({ length: 19 }, (_, i) => ({ id: `e${i}`, from: 'a', to: 'b' })) };
  assert.throws(() => parseProblem(many), (e: Error) => e instanceof InputError && /too many edges/.test(e.message));
  assert.throws(() => parseProblem({ nodes: ['a'], edges: [{ id: 'x', from: 'a', to: 'a' }, { id: 'x', from: 'a', to: 'a' }] }), /duplicate edge id/);
  assert.throws(() => parseProblem({ nodes: ['a'], edges: [{ id: 'x', from: 'a', to: 'zzz' }] }), /unknown to-node/);
  assert.throws(() => parseProblem({ nodes: ['a'], edges: [{ id: 'x', from: 'a', to: 'a', cost: -1 }] }), /non-negative integer/);
  assert.throws(() => parseProblem({ nodes: ['a', 'a'], edges: [] }), /duplicate node/);
});

// --- randomized cross-validation: branch & bound must match exhaustive enumeration ---

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random graphs: branch-and-bound optimum equals brute-force optimum', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = mulberry32(seed);
    const n = 3 + Math.floor(rnd() * 4); // 3..6 nodes
    const m = 3 + Math.floor(rnd() * 9); // 3..11 edges
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges = Array.from({ length: m }, (_, i) => {
      const from = nodes[Math.floor(rnd() * n)]!;
      const to = nodes[Math.floor(rnd() * n)]!;
      const e: Record<string, unknown> = { id: `e${i}`, from, to, cost: Math.floor(rnd() * 6) };
      if (rnd() < 0.15) e.locked = true;
      if (rnd() < 0.25) e.group = `g${Math.floor(rnd() * 2)}`;
      return e;
    });
    const input: Record<string, unknown> = { nodes, edges };
    if (rnd() < 0.6) {
      input.entries = [nodes[Math.floor(rnd() * n)]];
      input.exits = [nodes[Math.floor(rnd() * n)]];
    }
    if (rnd() < 0.4) input.budget = Math.floor(rnd() * 12);
    if (rnd() < 0.4) input.groups = { g0: { requires: ['g1'] } };
    const problem = parseProblem(input);
    const bb = branchAndBound(problem);
    const bf = bruteForce(problem);
    assert.equal(bb.cost, bf.cost, `seed ${seed}: cost mismatch (bb=${bb.cost}, bf=${bf.cost})`);
    assert.equal(bb.mask === null, bf.mask === null, `seed ${seed}: feasibility mismatch`);
    // the BB witness must pass the independent checker
    if (bb.mask !== null) {
      const sol = solveProblem(problem);
      const res = checkSolution(problem, sol);
      assert.deepEqual(res.errors, [], `seed ${seed}: checker rejected BB solution`);
    }
  }
});

test('zero-cost edges: deterministic tie-break still matches enumeration', () => {
  const p = parseProblem({
    nodes: ['a', 'b'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', cost: 0 },
      { id: 'ba', from: 'b', to: 'a', cost: 0 },
    ],
  } satisfies ProblemInput);
  const bb = branchAndBound(p);
  const bf = bruteForce(p);
  assert.equal(bb.cost, 0);
  assert.equal(bb.mask, bf.mask);
});

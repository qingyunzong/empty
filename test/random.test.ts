import test from 'node:test';
import assert from 'node:assert/strict';
import { solveLP, LPInput, Relation } from '../src/lp.js';
import { verifyResult } from '../src/check.js';
import { enumerateVertices } from '../src/vertex.js';

/** Deterministic PRNG (mulberry32) so test runs are reproducible. */
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

function randomLP(rand: () => number, maxVars: number, maxCons: number, eqProb: number): LPInput {
  const n = 1 + Math.floor(rand() * maxVars);
  const m = Math.floor(rand() * (maxCons + 1));
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const objective = Array.from({ length: n }, () => int(-9, 9));
  const constraints = Array.from({ length: m }, () => {
    const r = rand();
    const rel: Relation = r < eqProb ? '=' : r < 0.75 ? '<=' : '>=';
    return {
      a: Array.from({ length: n }, () => int(-5, 5)),
      rel,
      b: int(-10, 10),
    };
  });
  return { numVars: n, objective, constraints };
}

test('random small integer LPs: every certificate verifies (400 instances)', () => {
  const rand = mulberry32(20261005);
  const tally = { optimal: 0, infeasible: 0, unbounded: 0 };
  for (let k = 0; k < 400; k++) {
    const lp = randomLP(rand, 6, 12, 0.15);
    const res = solveLP(lp);
    tally[res.status]++;
    assert.doesNotThrow(() => verifyResult(lp, res), `instance ${k} (${JSON.stringify(lp)})`);
  }
  // sanity: the random mix should exercise all three outcomes
  assert.ok(tally.optimal > 0, JSON.stringify(tally));
  assert.ok(tally.infeasible > 0, JSON.stringify(tally));
  assert.ok(tally.unbounded > 0, JSON.stringify(tally));
  console.log('    outcome tally:', JSON.stringify(tally));
});

test('vertex enumeration cross-check on small integer LPs (150 instances)', () => {
  const rand = mulberry32(987654321);
  const tally = { optimal: 0, infeasible: 0, unbounded: 0 };
  for (let k = 0; k < 150; k++) {
    const lp = randomLP(rand, 4, 6, 0.1);
    const res = solveLP(lp);
    tally[res.status]++;
    verifyResult(lp, res);
    const vertices = enumerateVertices(lp);
    if (res.status === 'optimal') {
      // bounded feasible LP: optimum is attained at a vertex
      assert.ok(vertices.feasible, `instance ${k}: simplex optimal but no vertex found`);
      assert.ok(
        vertices.bestValue !== null && vertices.bestValue.equals(res.value),
        `instance ${k}: simplex ${res.value} != vertex optimum ${vertices.bestValue}`,
      );
    } else if (res.status === 'infeasible') {
      // pointed feasible set would have had a basic feasible solution
      assert.ok(!vertices.feasible, `instance ${k}: simplex infeasible but vertex exists`);
    }
    // unbounded: certified by the ray; vertex enumeration not applicable
  }
  assert.ok(tally.optimal > 0 && tally.infeasible > 0 && tally.unbounded > 0, JSON.stringify(tally));
  console.log('    outcome tally:', JSON.stringify(tally));
});

test('vertex enumeration agrees on dense equality-heavy instances', () => {
  const rand = mulberry32(424242);
  let checked = 0;
  for (let k = 0; k < 60; k++) {
    const lp = randomLP(rand, 3, 5, 0.4);
    const res = solveLP(lp);
    verifyResult(lp, res);
    if (res.status !== 'optimal') continue;
    const vertices = enumerateVertices(lp);
    assert.ok(vertices.bestValue !== null && vertices.bestValue.equals(res.value));
    checked++;
  }
  assert.ok(checked > 0, 'no optimal instances generated');
  console.log(`    equality-heavy optima cross-checked: ${checked}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Frac } from '../src/rational.js';
import { solveLP, LPInput } from '../src/lp.js';
import { verifyResult } from '../src/check.js';

function solved(lp: LPInput) {
  const res = solveLP(lp);
  verifyResult(lp, res); // every result must carry a valid certificate
  return res;
}

test('optimal: fractional vertex, strong duality', () => {
  const lp: LPInput = {
    numVars: 2,
    objective: [1, 1],
    constraints: [
      { a: [1, 2], rel: '<=', b: 4 },
      { a: [2, 1], rel: '<=', b: 4 },
    ],
  };
  const res = solved(lp);
  assert.equal(res.status, 'optimal');
  if (res.status !== 'optimal') return;
  assert.equal(res.value.toString(), '8/3');
  assert.ok(res.x.every((v) => v.equals(Frac.parse('4/3'))));
});

test('optimal: mixed relations including equality', () => {
  const lp: LPInput = {
    numVars: 2,
    objective: [1, 0],
    constraints: [
      { a: [1, 1], rel: '=', b: 4 },
      { a: [1, 2], rel: '<=', b: 6 },
      { a: [1, 0], rel: '>=', b: 1 },
    ],
  };
  const res = solved(lp);
  assert.equal(res.status, 'optimal');
  if (res.status !== 'optimal') return;
  assert.equal(res.value.toString(), '4');
});

test('infeasible: Farkas certificate', () => {
  const lp: LPInput = {
    numVars: 2,
    objective: [1, 1],
    constraints: [
      { a: [1, 1], rel: '<=', b: 1 },
      { a: [1, 1], rel: '>=', b: 3 },
    ],
  };
  const res = solved(lp);
  assert.equal(res.status, 'infeasible');
});

test('infeasible: conflicting equalities with negative rhs', () => {
  const lp: LPInput = {
    numVars: 3,
    objective: [1, -1, 2],
    constraints: [
      { a: [1, 1, 1], rel: '=', b: 2 },
      { a: [2, 2, 2], rel: '=', b: 5 },
      { a: [1, -1, 0], rel: '<=', b: -1 },
    ],
  };
  const res = solved(lp);
  assert.equal(res.status, 'infeasible');
});

test('unbounded: feasible point plus improving ray', () => {
  const lp: LPInput = {
    numVars: 2,
    objective: [1, 1],
    constraints: [{ a: [1, -1], rel: '<=', b: 1 }],
  };
  const res = solved(lp);
  assert.equal(res.status, 'unbounded');
  if (res.status !== 'unbounded') return;
  assert.ok(res.ray.some((v) => v.sign() > 0));
});

test('unbounded: no constraints at all', () => {
  const lp: LPInput = { numVars: 3, objective: [0, -1, 2], constraints: [] };
  const res = solved(lp);
  assert.equal(res.status, 'unbounded');
});

test('optimal: zero objective, trivial vertex', () => {
  const lp: LPInput = {
    numVars: 2,
    objective: [-1, -2],
    constraints: [{ a: [1, 1], rel: '<=', b: 5 }],
  };
  const res = solved(lp);
  assert.equal(res.status, 'optimal');
  if (res.status !== 'optimal') return;
  assert.equal(res.value.toString(), '0');
});

test("Beale's cycling example terminates under Bland's rule", () => {
  const lp: LPInput = {
    numVars: 4,
    objective: ['3/4', -150, '1/50', -6],
    constraints: [
      { a: ['1/4', -60, '-1/25', 9], rel: '<=', b: 0 },
      { a: ['1/2', -90, '-1/50', 3], rel: '<=', b: 0 },
      { a: [0, 0, 1, 0], rel: '<=', b: 1 },
    ],
  };
  const res = solved(lp);
  assert.equal(res.status, 'optimal');
  if (res.status !== 'optimal') return;
  assert.equal(res.value.toString(), '1/20');
});

test('redundant and degenerate constraints', () => {
  const lp: LPInput = {
    numVars: 2,
    objective: [1, 1],
    constraints: [
      { a: [1, 0], rel: '<=', b: 1 },
      { a: [2, 0], rel: '<=', b: 2 }, // redundant copy
      { a: [0, 1], rel: '<=', b: 2 },
      { a: [1, 1], rel: '<=', b: 3 }, // degenerate at optimum
    ],
  };
  const res = solved(lp);
  assert.equal(res.status, 'optimal');
  if (res.status !== 'optimal') return;
  assert.equal(res.value.toString(), '3');
});

test('limits are enforced', () => {
  assert.throws(
    () => solveLP({ numVars: 7, objective: [1, 1, 1, 1, 1, 1, 1], constraints: [] }),
    RangeError,
  );
  const tooMany = Array.from({ length: 13 }, () => ({ a: [1], rel: '<=' as const, b: 1 }));
  assert.throws(() => solveLP({ numVars: 1, objective: [1], constraints: tooMany }), RangeError);
});

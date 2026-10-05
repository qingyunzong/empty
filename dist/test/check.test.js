import test from 'node:test';
import assert from 'node:assert/strict';
import { Frac } from '../src/rational.js';
import { solveLP } from '../src/lp.js';
import { verifyResult } from '../src/check.js';
const lp = {
    numVars: 2,
    objective: [1, 1],
    constraints: [
        { a: [1, 2], rel: '<=', b: 4 },
        { a: [2, 1], rel: '<=', b: 4 },
    ],
};
test('checker accepts the solver certificate', () => {
    assert.doesNotThrow(() => verifyResult(lp, solveLP(lp)));
});
test('checker rejects a tampered primal point', () => {
    const res = solveLP(lp);
    if (res.status !== 'optimal')
        assert.fail('expected optimal');
    const bad = { ...res, x: [Frac.parse('4/3'), Frac.parse('5/3')] };
    assert.throws(() => verifyResult(lp, bad), /certificate rejected/);
});
test('checker rejects a tampered dual', () => {
    const res = solveLP(lp);
    if (res.status !== 'optimal')
        assert.fail('expected optimal');
    const badY = res.y.slice();
    badY[0] = badY[0].add(1);
    const bad = { ...res, y: badY };
    assert.throws(() => verifyResult(lp, bad), /certificate rejected/);
});
test('checker rejects a tampered optimal value', () => {
    const res = solveLP(lp);
    if (res.status !== 'optimal')
        assert.fail('expected optimal');
    const bad = { ...res, value: res.value.add(1) };
    assert.throws(() => verifyResult(lp, bad), /certificate rejected/);
});
test('checker rejects a fake Farkas certificate', () => {
    const infeasible = {
        numVars: 2,
        objective: [1, 0],
        constraints: [
            { a: [1, 1], rel: '<=', b: 1 },
            { a: [1, 1], rel: '>=', b: 3 },
        ],
    };
    const res = solveLP(infeasible);
    if (res.status !== 'infeasible')
        assert.fail('expected infeasible');
    assert.doesNotThrow(() => verifyResult(infeasible, res));
    const bad = {
        status: 'infeasible',
        farkas: res.farkas.map((v) => v.neg()),
    };
    assert.throws(() => verifyResult(infeasible, bad), /certificate rejected/);
    // a true Farkas vector for one problem means nothing for a feasible one
    assert.throws(() => verifyResult(lp, res), /certificate rejected/);
});
test('checker rejects a fake unbounded ray', () => {
    const unbounded = {
        numVars: 2,
        objective: [1, 1],
        constraints: [{ a: [1, -1], rel: '<=', b: 1 }],
    };
    const res = solveLP(unbounded);
    if (res.status !== 'unbounded')
        assert.fail('expected unbounded');
    assert.doesNotThrow(() => verifyResult(unbounded, res));
    const badRay = {
        ...res,
        ray: res.ray.map((v) => v.neg()), // flips sign of every gain
    };
    assert.throws(() => verifyResult(unbounded, badRay), /certificate rejected/);
    const infeasibleBase = {
        ...res,
        x0: [Frac.parse('-1'), Frac.ZERO],
    };
    assert.throws(() => verifyResult(unbounded, infeasibleBase), /certificate rejected/);
});
test('checker rejects wrong-status claims on a bounded LP', () => {
    assert.throws(() => verifyResult(lp, {
        status: 'unbounded',
        x0: [Frac.ZERO, Frac.ZERO],
        ray: [Frac.ONE, Frac.ONE],
    }), /certificate rejected/);
});

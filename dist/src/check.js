/**
 * Independent certificate checker. Shares only the rational type and the
 * input parser with the solver; all verification logic is written directly
 * against the ORIGINAL problem formulation, using exact arithmetic only.
 *
 * Primal:   max c·x  s.t.  a_i·x rel_i b_i,  x >= 0
 * Dual:     min b·y  s.t.  A^T y >= c,  y_i >= 0 for '<=', y_i <= 0 for '>=',
 *           y_i free for '='.
 */
import { Frac } from './rational.js';
import { parseLP } from './lp.js';
function fail(reason) {
    throw new Error(`certificate rejected: ${reason}`);
}
function dot(u, v) {
    let acc = Frac.ZERO;
    for (let i = 0; i < u.length; i++)
        acc = acc.add(u[i].mul(v[i]));
    return acc;
}
function checkPrimalFeasible(lp, x, context) {
    const p = parseLP(lp);
    if (x.length !== p.n)
        fail(`${context}: expected ${p.n} variables, got ${x.length}`);
    for (let j = 0; j < p.n; j++) {
        if (x[j].sign() < 0)
            fail(`${context}: x_${j} = ${x[j]} < 0`);
    }
    for (let i = 0; i < p.A.length; i++) {
        const lhs = dot(p.A[i], x);
        const rhs = p.b[i];
        const cmp = lhs.cmp(rhs);
        if (p.rel[i] === '<=' && cmp > 0) {
            fail(`${context}: constraint ${i} violated: ${lhs} <= ${rhs} fails`);
        }
        if (p.rel[i] === '>=' && cmp < 0) {
            fail(`${context}: constraint ${i} violated: ${lhs} >= ${rhs} fails`);
        }
        if (p.rel[i] === '=' && cmp !== 0) {
            fail(`${context}: constraint ${i} violated: ${lhs} = ${rhs} fails`);
        }
    }
}
function checkDualSigns(lp, y, context) {
    const p = parseLP(lp);
    if (y.length !== p.A.length) {
        fail(`${context}: expected ${p.A.length} dual multipliers, got ${y.length}`);
    }
    for (let i = 0; i < p.A.length; i++) {
        if (p.rel[i] === '<=' && y[i].sign() < 0) {
            fail(`${context}: y_${i} = ${y[i]} must be >= 0 for a '<=' constraint`);
        }
        if (p.rel[i] === '>=' && y[i].sign() > 0) {
            fail(`${context}: y_${i} = ${y[i]} must be <= 0 for a '>=' constraint`);
        }
    }
}
/** Throws with a precise reason if the certificate is invalid; returns void otherwise. */
export function verifyResult(lp, result) {
    const p = parseLP(lp);
    if (result.status === 'optimal') {
        checkPrimalFeasible(lp, result.x, 'primal');
        checkDualSigns(lp, result.y, 'dual');
        for (let j = 0; j < p.n; j++) {
            let lhs = Frac.ZERO;
            for (let i = 0; i < p.A.length; i++)
                lhs = lhs.add(result.y[i].mul(p.A[i][j]));
            if (lhs.cmp(p.c[j]) < 0) {
                fail(`dual infeasible in column ${j}: (A^T y)_${j} = ${lhs} < c_${j} = ${p.c[j]}`);
            }
        }
        const primalObj = dot(p.c, result.x);
        const dualObj = dot(p.b, result.y);
        if (!primalObj.equals(dualObj)) {
            fail(`duality gap: c·x = ${primalObj} != b·y = ${dualObj}`);
        }
        if (!primalObj.equals(result.value)) {
            fail(`reported value ${result.value} != c·x = ${primalObj}`);
        }
        return;
    }
    if (result.status === 'infeasible') {
        const y = result.farkas;
        checkDualSigns(lp, y, 'farkas');
        for (let j = 0; j < p.n; j++) {
            let lhs = Frac.ZERO;
            for (let i = 0; i < p.A.length; i++)
                lhs = lhs.add(y[i].mul(p.A[i][j]));
            if (lhs.sign() < 0) {
                fail(`farkas: (A^T y)_${j} = ${lhs} < 0`);
            }
        }
        const by = dot(p.b, y);
        if (by.sign() >= 0) {
            fail(`farkas: b·y = ${by} is not < 0`);
        }
        return;
    }
    // unbounded: feasible x0 plus a recession ray d improving the objective
    checkPrimalFeasible(lp, result.x0, 'unbounded base point');
    const d = result.ray;
    if (d.length !== p.n)
        fail(`unbounded: ray has ${d.length} components, expected ${p.n}`);
    for (let j = 0; j < p.n; j++) {
        if (d[j].sign() < 0)
            fail(`unbounded: ray component d_${j} = ${d[j]} < 0`);
    }
    for (let i = 0; i < p.A.length; i++) {
        const ad = dot(p.A[i], d);
        if (p.rel[i] === '<=' && ad.sign() > 0) {
            fail(`unbounded: constraint ${i} grows along ray: a·d = ${ad} > 0`);
        }
        if (p.rel[i] === '>=' && ad.sign() < 0) {
            fail(`unbounded: constraint ${i} shrinks along ray: a·d = ${ad} < 0`);
        }
        if (p.rel[i] === '=' && !ad.isZero()) {
            fail(`unbounded: equality ${i} not preserved along ray: a·d = ${ad}`);
        }
    }
    const cd = dot(p.c, d);
    if (cd.sign() <= 0) {
        fail(`unbounded: objective gain along ray c·d = ${cd} is not > 0`);
    }
}

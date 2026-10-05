/**
 * Exact two-phase simplex (dictionary form, Bland's rule) over rationals.
 *
 * Solves:  max c·x  s.t.  a_i·x (<=|>=|=) b_i,  x >= 0,
 * with n <= MAX_VARS variables and m <= MAX_CONSTRAINTS constraints.
 *
 * Every result carries an exact, independently checkable certificate:
 *  - optimal:    primal x*, dual y* with c·x* = b·y* (strong duality)
 *  - infeasible: Farkas vector y, A^T y >= 0, b·y < 0 (sign-restricted)
 *  - unbounded:  feasible point x0 and ray d >= 0 with c·d > 0
 */
import { Frac, fracArray } from './rational.js';
export const MAX_VARS = 6;
export const MAX_CONSTRAINTS = 12;
export function parseLP(input) {
    const n = input.numVars;
    if (!Number.isInteger(n) || n < 1 || n > MAX_VARS) {
        throw new RangeError(`numVars must be an integer in [1, ${MAX_VARS}], got ${n}`);
    }
    if (input.constraints.length > MAX_CONSTRAINTS) {
        throw new RangeError(`at most ${MAX_CONSTRAINTS} constraints supported, got ${input.constraints.length}`);
    }
    if (input.objective.length !== n) {
        throw new Error(`objective length ${input.objective.length} != numVars ${n}`);
    }
    const c = fracArray(input.objective);
    const A = [];
    const rel = [];
    const b = [];
    for (const con of input.constraints) {
        if (con.a.length !== n) {
            throw new Error(`constraint row length ${con.a.length} != numVars ${n}`);
        }
        if (con.rel !== '<=' && con.rel !== '>=' && con.rel !== '=') {
            throw new Error(`invalid relation ${String(con.rel)}`);
        }
        A.push(fracArray(con.a));
        rel.push(con.rel);
        b.push(Frac.from(con.b));
    }
    return { n, c, A, rel, b };
}
function pivot(tab, r, s) {
    const { nCols, m, T } = tab;
    const inv = Frac.ONE.div(T[r][s]);
    const rowR = T[r];
    for (let j = 0; j <= nCols; j++)
        rowR[j] = rowR[j].mul(inv);
    for (let i = 0; i < m; i++) {
        if (i === r)
            continue;
        const factor = T[i][s];
        if (factor.isZero())
            continue;
        const rowI = T[i];
        for (let j = 0; j <= nCols; j++) {
            rowI[j] = rowI[j].sub(factor.mul(rowR[j]));
        }
    }
    const objS = tab.obj[s];
    if (!objS.isZero()) {
        for (let j = 0; j < nCols; j++) {
            tab.obj[j] = tab.obj[j].sub(objS.mul(rowR[j]));
        }
        tab.v = tab.v.add(objS.mul(rowR[nCols]));
    }
    tab.basis[r] = s;
}
/** Rewrite z so basic variables have zero coefficient. */
function eliminateBasic(tab) {
    for (let i = 0; i < tab.m; i++) {
        const coeff = tab.obj[tab.basis[i]];
        if (coeff.isZero())
            continue;
        const rowI = tab.T[i];
        for (let j = 0; j < tab.nCols; j++) {
            tab.obj[j] = tab.obj[j].sub(coeff.mul(rowI[j]));
        }
        tab.v = tab.v.add(coeff.mul(rowI[tab.nCols]));
    }
}
/** Bland's rule: smallest-index entering, smallest-basis-index tie-break. Terminates always. */
function runSimplex(tab) {
    for (;;) {
        let s = -1;
        for (let j = 0; j < tab.nCols; j++) {
            if (tab.obj[j].sign() > 0) {
                s = j;
                break;
            }
        }
        if (s === -1)
            return { status: 'optimal' };
        let r = -1;
        let bestRatio = null;
        for (let i = 0; i < tab.m; i++) {
            const coeff = tab.T[i][s];
            if (coeff.sign() <= 0)
                continue;
            const ratio = tab.T[i][tab.nCols].div(coeff);
            if (bestRatio === null ||
                ratio.cmp(bestRatio) < 0 ||
                (ratio.cmp(bestRatio) === 0 && tab.basis[i] < tab.basis[r])) {
                bestRatio = ratio;
                r = i;
            }
        }
        if (r === -1)
            return { status: 'unbounded', entering: s };
        pivot(tab, r, s);
    }
}
export function solveLP(input) {
    const lp = parseLP(input);
    const n = lp.n;
    // Normalize every constraint to "<=" rows, remembering how to map dual
    // multipliers back: original y_k = sum_i rowMap[i].sign * yHat_i.
    const rows = [];
    const rhs = [];
    const rowMap = [];
    lp.A.forEach((a, k) => {
        const pushRow = (sign) => {
            rows.push(sign === 1 ? a.slice() : a.map((v) => v.neg()));
            rhs.push(sign === 1 ? lp.b[k] : lp.b[k].neg());
            rowMap.push({ orig: k, sign });
        };
        if (lp.rel[k] === '<=')
            pushRow(1);
        else if (lp.rel[k] === '>=')
            pushRow(-1);
        else {
            pushRow(1);
            pushRow(-1);
        }
    });
    const m = rows.length;
    const negRows = [];
    for (let i = 0; i < m; i++)
        if (rhs[i].sign() < 0)
            negRows.push(i);
    // Column layout: [x_0..x_{n-1} | slack_0..slack_{m-1} | artificials | RHS]
    const nArt = negRows.length;
    const nCols = n + m + nArt;
    const slackCol = (i) => n + i;
    const artCol = new Map();
    negRows.forEach((rowIdx, k) => artCol.set(rowIdx, n + m + k));
    const isArtificial = (col) => col >= n + m;
    const T = [];
    const basis = [];
    for (let i = 0; i < m; i++) {
        const row = new Array(nCols + 1).fill(Frac.ZERO);
        for (let j = 0; j < n; j++)
            row[j] = rows[i][j];
        row[slackCol(i)] = Frac.ONE;
        row[nCols] = rhs[i];
        const ac = artCol.get(i);
        if (ac !== undefined) {
            for (let j = 0; j <= nCols; j++)
                row[j] = row[j].neg();
            row[ac] = Frac.ONE;
            basis.push(ac);
        }
        else {
            basis.push(slackCol(i));
        }
        T.push(row);
    }
    let tab = { m, nCols, T, basis, obj: new Array(nCols).fill(Frac.ZERO), v: Frac.ZERO };
    const mapDual = (yHat) => {
        const y = new Array(lp.A.length).fill(Frac.ZERO);
        for (let i = 0; i < m; i++) {
            const { orig, sign } = rowMap[i];
            y[orig] = sign === 1 ? y[orig].add(yHat[i]) : y[orig].sub(yHat[i]);
        }
        return y;
    };
    // ---- Phase 1: minimize sum of artificials (as max of its negation). ----
    if (nArt > 0) {
        tab.obj = new Array(nCols).fill(Frac.ZERO);
        for (const ac of artCol.values())
            tab.obj[ac] = Frac.ONE.neg();
        eliminateBasic(tab);
        runSimplex(tab); // phase 1 is bounded above by 0, always ends optimal
        if (tab.v.sign() < 0) {
            // Farkas certificate: yHat_i = -(reduced cost of slack_i); then
            // yHat >= 0, yHat^T Ahat >= 0 and yHat . bHat = v < 0.
            const yHat = [];
            for (let i = 0; i < m; i++)
                yHat.push(tab.obj[slackCol(i)].neg());
            return { status: 'infeasible', farkas: mapDual(yHat) };
        }
        // Drive basic artificials (necessarily at value 0) out of the basis.
        for (let i = 0; i < m; i++) {
            if (!isArtificial(tab.basis[i]))
                continue;
            let pivoted = false;
            for (let j = 0; j < nCols; j++) {
                if (isArtificial(j) || tab.T[i][j].isZero())
                    continue;
                pivot(tab, i, j);
                pivoted = true;
                break;
            }
            if (!pivoted) {
                // Row of B^{-1}[A|I] cannot be identically zero; unreachable.
                throw new Error('internal: redundant constraint could not be pivoted out');
            }
        }
        // Rebuild the tableau without artificial columns.
        const keep = [];
        for (let j = 0; j < nCols; j++)
            if (!isArtificial(j))
                keep.push(j);
        const remap = new Map();
        keep.forEach((old, idx) => remap.set(old, idx));
        const T2 = T.map((row) => keep.map((j) => row[j]).concat(row[nCols]));
        const basis2 = tab.basis.map((bcol) => remap.get(bcol));
        tab = {
            m,
            nCols: keep.length,
            T: T2,
            basis: basis2,
            obj: new Array(keep.length).fill(Frac.ZERO),
            v: Frac.ZERO,
        };
    }
    const slackCol2 = (i) => n + i;
    // ---- Phase 2: the real objective. ----
    tab.obj = new Array(tab.nCols).fill(Frac.ZERO);
    for (let j = 0; j < n; j++)
        tab.obj[j] = lp.c[j];
    eliminateBasic(tab);
    const outcome = runSimplex(tab);
    const currentX = () => {
        const x = new Array(n).fill(Frac.ZERO);
        for (let i = 0; i < tab.m; i++) {
            if (tab.basis[i] < n)
                x[tab.basis[i]] = tab.T[i][tab.nCols];
        }
        return x;
    };
    if (outcome.status === 'unbounded') {
        const s = outcome.entering;
        const ray = new Array(n).fill(Frac.ZERO);
        if (s < n)
            ray[s] = Frac.ONE;
        for (let i = 0; i < tab.m; i++) {
            const bcol = tab.basis[i];
            if (bcol < n)
                ray[bcol] = tab.T[i][s].neg();
        }
        return { status: 'unbounded', x0: currentX(), ray };
    }
    const yHat = [];
    for (let i = 0; i < m; i++)
        yHat.push(tab.obj[slackCol2(i)].neg());
    return { status: 'optimal', value: tab.v, x: currentX(), y: mapDual(yHat) };
}

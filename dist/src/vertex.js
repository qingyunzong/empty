/**
 * Brute-force vertex enumeration, used only as an independent cross-check
 * for small instances. Enumerates every basic solution of the equality
 * system [Ahat | I] z = b, z >= 0 (z = (x, slack)) by exact Gaussian
 * elimination, and keeps the best feasible vertex value.
 *
 * Soundness: the feasible set lies inside the nonnegative orthant, hence is
 * pointed; so a nonempty feasible set always has a basic feasible solution,
 * and a bounded feasible LP always attains its optimum at a vertex.
 */
import { Frac } from './rational.js';
import { parseLP } from './lp.js';
/** Exact solve of M z = rhs for a square matrix; null if singular. */
export function solveSquare(M, rhs) {
    const k = M.length;
    const a = M.map((row, i) => row.concat(rhs[i]));
    for (let col = 0; col < k; col++) {
        let piv = -1;
        for (let r = col; r < k; r++) {
            if (!a[r][col].isZero()) {
                piv = r;
                break;
            }
        }
        if (piv === -1)
            return null;
        if (piv !== col) {
            const tmp = a[col];
            a[col] = a[piv];
            a[piv] = tmp;
        }
        const inv = Frac.ONE.div(a[col][col]);
        for (let j = col; j <= k; j++)
            a[col][j] = a[col][j].mul(inv);
        for (let r = 0; r < k; r++) {
            if (r === col)
                continue;
            const f = a[r][col];
            if (f.isZero())
                continue;
            for (let j = col; j <= k; j++)
                a[r][j] = a[r][j].sub(f.mul(a[col][j]));
        }
    }
    return a.map((row) => row[k]);
}
function* combinations(total, pick) {
    const idx = Array.from({ length: pick }, (_, i) => i);
    if (pick > total)
        return;
    for (;;) {
        yield idx.slice();
        let i = pick - 1;
        while (i >= 0 && idx[i] === total - pick + i)
            i--;
        if (i < 0)
            return;
        idx[i]++;
        for (let j = i + 1; j < pick; j++)
            idx[j] = idx[j - 1] + 1;
    }
}
export function enumerateVertices(input) {
    const lp = parseLP(input);
    const n = lp.n;
    // Independent normalization to "<=" rows (own code path, not the solver's).
    const rows = [];
    const rhs = [];
    lp.A.forEach((a, k) => {
        const push = (sign) => {
            rows.push(sign === 1 ? a.slice() : a.map((v) => v.neg()));
            rhs.push(sign === 1 ? lp.b[k] : lp.b[k].neg());
        };
        if (lp.rel[k] === '<=')
            push(1);
        else if (lp.rel[k] === '>=')
            push(-1);
        else {
            push(1);
            push(-1);
        }
    });
    const m = rows.length;
    const total = n + m;
    // Columns of [Ahat | I].
    const col = (j) => {
        const v = new Array(m).fill(Frac.ZERO);
        if (j < n) {
            for (let i = 0; i < m; i++)
                v[i] = rows[i][j];
        }
        else {
            v[j - n] = Frac.ONE;
        }
        return v;
    };
    let best = null;
    let bestVertex = null;
    let basesEnumerated = 0;
    let feasibleBases = 0;
    for (const basisIdx of combinations(total, m)) {
        basesEnumerated++;
        const M = Array.from({ length: m }, () => new Array(m).fill(Frac.ZERO));
        basisIdx.forEach((colIdx, pos) => {
            const c = col(colIdx);
            for (let i = 0; i < m; i++)
                M[i][pos] = c[i];
        });
        const z = solveSquare(M, rhs);
        if (z === null)
            continue;
        if (z.some((v) => v.sign() < 0))
            continue;
        feasibleBases++;
        const x = new Array(n).fill(Frac.ZERO);
        basisIdx.forEach((colIdx, pos) => {
            if (colIdx < n)
                x[colIdx] = z[pos];
        });
        let value = Frac.ZERO;
        for (let j = 0; j < n; j++)
            value = value.add(lp.c[j].mul(x[j]));
        if (best === null || value.cmp(best) > 0) {
            best = value;
            bestVertex = x;
        }
    }
    return {
        feasible: feasibleBases > 0,
        bestValue: best,
        bestVertex,
        basesEnumerated,
        feasibleBases,
    };
}

/** Lexicographic comparison; equal-length vectors. Negative iff a < b. */
export function lexCmp(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const av = a[i];
        const bv = b[i];
        if (av !== bv)
            return av - bv;
    }
    return a.length - b.length;
}
/**
 * Candidate thresholds for one group: every distinct score plus max+1
 * (reject-all). Tied scores always share a decision because acceptance is
 * `score >= threshold`. Dominated options are Pareto-pruned; among options
 * with identical (fp, fn) the smallest threshold is kept so the
 * lexicographic tie-break stays exact.
 */
export function groupOptions(group) {
    const uniq = [...new Set(group.samples.map((s) => s.score))].sort((a, b) => a - b);
    const candidates = uniq.length === 0 ? [0] : [...uniq, uniq[uniq.length - 1] + 1];
    const opts = candidates.map((t) => {
        let fp = 0;
        let fn = 0;
        for (const s of group.samples) {
            if (s.score >= t) {
                if (s.label === 0)
                    fp++;
            }
            else if (s.label === 1) {
                fn++;
            }
        }
        return { threshold: t, fp, fn };
    });
    opts.sort((a, b) => a.fp - b.fp || a.fn - b.fn || a.threshold - b.threshold);
    const pareto = [];
    let bestFn = Infinity;
    for (const o of opts) {
        if (o.fn < bestFn) {
            pareto.push(o);
            bestFn = o.fn;
        }
    }
    return pareto;
}
function better(a, b) {
    return a.fn < b.fn || (a.fn === b.fn && lexCmp(a.vector, b.vector) < 0);
}
/**
 * DP over groups: dp[f] = best (min fn, then lexicographically smallest
 * threshold prefix) achievable with the processed groups using exactly f
 * false positives. Prefix-lex comparison is valid because lexicographic
 * order is prefix-consistent.
 */
export function solve(groups, budget) {
    const options = groups.map(groupOptions);
    const tables = [];
    let dp = [{ fn: 0, vector: [] }];
    tables.push(dp);
    for (const opts of options) {
        const next = new Array(budget + 1).fill(null);
        for (let f = 0; f <= budget; f++) {
            const cur = dp[f];
            if (!cur)
                continue;
            for (const o of opts) {
                const nf = f + o.fp;
                if (nf > budget)
                    continue;
                const cand = {
                    fn: cur.fn + o.fn,
                    vector: [...cur.vector, o.threshold],
                };
                const ex = next[nf];
                if (!ex || better(cand, ex))
                    next[nf] = cand;
            }
        }
        dp = next;
        tables.push(dp);
    }
    let best = null;
    let bestF = 0;
    for (let f = 0; f <= budget; f++) {
        const c = dp[f];
        if (c && (!best || better(c, best))) {
            best = c;
            bestF = f;
        }
    }
    if (!best)
        throw new Error("infeasible: no threshold vector within budget");
    return { options, tables, vector: best.vector, fn: best.fn, fp: bestF };
}
/**
 * Independent exhaustive check over the Cartesian product of each group's
 * Pareto options (valid because pruning never removes an optimal or
 * lex-minimal choice). Skipped with a reason when the product exceeds cap.
 */
export function bruteForce(options, budget, cap = 1_000_000) {
    const combos = options.reduce((acc, o) => acc * o.length, 1);
    if (combos > cap) {
        return {
            status: "skipped",
            combos,
            reason: `combination count ${combos} exceeds cap ${cap}`,
        };
    }
    const k = options.length;
    const idx = new Array(k).fill(0);
    let best = null;
    for (;;) {
        let fp = 0;
        let fn = 0;
        const vector = [];
        for (let g = 0; g < k; g++) {
            const o = options[g][idx[g]];
            fp += o.fp;
            fn += o.fn;
            vector.push(o.threshold);
        }
        if (fp <= budget) {
            const cand = { fn, fp, vector };
            if (!best ||
                cand.fn < best.fn ||
                (cand.fn === best.fn && lexCmp(cand.vector, best.vector) < 0)) {
                best = cand;
            }
        }
        let g = k - 1;
        while (g >= 0) {
            idx[g]++;
            if (idx[g] < options[g].length)
                break;
            idx[g] = 0;
            g--;
        }
        if (g < 0)
            break;
    }
    if (!best)
        return { status: "ok", combos };
    return { status: "ok", combos, fn: best.fn, fp: best.fp, vector: best.vector };
}
export function confusion(group, threshold) {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const s of group.samples) {
        const accept = s.score >= threshold;
        if (accept && s.label === 1)
            tp++;
        else if (accept && s.label === 0)
            fp++;
        else if (!accept && s.label === 1)
            fn++;
        else
            tn++;
    }
    return { tp, fp, tn, fn };
}

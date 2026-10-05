/** Deterministic PRNG so test runs are reproducible. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function randInt(rng, lo, hi) {
    return lo + Math.floor(rng() * (hi - lo + 1));
}
export function toRecipients(rs) {
    return rs.map((r) => ({ id: r.id, weight: r.w, min: r.min, max: r.max }));
}
/** Exact squared-deviation cost (integer math; matches src/split.ts scaling). */
export function costOf(rs, total, x) {
    const W = rs.reduce((s, r) => s + r.w, 0);
    let sum = 0n;
    for (let i = 0; i < rs.length; i++) {
        const d = W > 0
            ? BigInt(x[i]) * BigInt(W) - BigInt(total) * BigInt(rs[i].w)
            : BigInt(x[i]);
        sum += d * d;
    }
    return sum;
}
/**
 * Full enumeration of every allocation within bounds summing to `total`;
 * returns the minimum exact squared-deviation cost, or null if infeasible.
 */
export function bruteForceMinCost(rs, total) {
    const n = rs.length;
    const x = new Array(n).fill(0);
    let best = null;
    const suffixMax = new Array(n + 1).fill(0);
    const suffixMin = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        suffixMax[i] = suffixMax[i + 1] + rs[i].max;
        suffixMin[i] = suffixMin[i + 1] + rs[i].min;
    }
    const walk = (i, rest) => {
        if (rest < suffixMin[i] || rest > suffixMax[i])
            return;
        if (i === n) {
            if (rest === 0) {
                const c = costOf(rs, total, x);
                if (best === null || c < best)
                    best = c;
            }
            return;
        }
        const r = rs[i];
        for (let v = r.min; v <= Math.min(r.max, rest); v++) {
            x[i] = v;
            walk(i + 1, rest - v);
        }
    };
    walk(0, total);
    return best;
}
/**
 * Meet-in-the-middle full enumeration: exact minimum cost over ALL
 * allocations, feasible for 8 recipients and total 100.  The objective is
 * separable per recipient, so each half only needs the best cost per
 * partial sum.
 */
export function bruteForceMinCostMITM(rs, total) {
    const half = Math.floor(rs.length / 2);
    const bestPerSum = (part) => {
        const map = new Map();
        const x = new Array(part.length).fill(0);
        const W = rs.reduce((s, r) => s + r.w, 0);
        const walk = (i, rest, acc) => {
            if (i === part.length) {
                const s = total - rest;
                const cur = map.get(s);
                if (cur === undefined || acc < cur)
                    map.set(s, acc);
                return;
            }
            const r = part[i];
            for (let v = r.min; v <= Math.min(r.max, rest); v++) {
                x[i] = v;
                const d = W > 0
                    ? BigInt(v) * BigInt(W) - BigInt(total) * BigInt(r.w)
                    : BigInt(v);
                walk(i + 1, rest - v, acc + d * d);
            }
        };
        walk(0, total, 0n);
        return map;
    };
    const left = bestPerSum(rs.slice(0, half));
    const right = bestPerSum(rs.slice(half));
    let best = null;
    for (const [s, c] of left) {
        const other = right.get(total - s);
        if (other === undefined)
            continue;
        const sum = c + other;
        if (best === null || sum < best)
            best = sum;
    }
    return best;
}

"use strict";
/**
 * Reference implementation: enumerate every subset of indices to find the
 * longest strictly increasing subsequence and the lexicographically smallest
 * INDEX sequence among all optima. Used to cross-check the main algorithm on
 * small sequences (length and unique selection).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bruteForceLis = bruteForceLis;
function indexLexLess(a, b) {
    for (let i = 0; i < a.length && i < b.length; i++) {
        if (a[i] !== b[i])
            return a[i] < b[i];
    }
    return a.length < b.length;
}
function bruteForceLis(values) {
    const n = values.length;
    if (n > 26)
        throw new RangeError("brute force limited to n <= 26");
    let bestLen = 0;
    let bestIdx = [];
    let optimalCount = 0;
    const total = 2 ** n;
    for (let mask = 0; mask < total; mask++) {
        const idx = [];
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
            if ((mask & (1 << i)) !== 0) {
                if (idx.length > 0 && values[i] <= values[idx[idx.length - 1]]) {
                    ok = false;
                }
                else {
                    idx.push(i);
                }
            }
        }
        if (!ok)
            continue;
        if (idx.length > bestLen) {
            bestLen = idx.length;
            bestIdx = idx;
            optimalCount = 1;
        }
        else if (idx.length === bestLen) {
            optimalCount++;
            if (indexLexLess(idx, bestIdx))
                bestIdx = idx;
        }
    }
    return { length: bestLen, indices: bestIdx, optimalCount };
}

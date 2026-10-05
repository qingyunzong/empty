"use strict";
/**
 * Sequence library supporting append-at-end and undo, returning the longest
 * strictly increasing subsequence (LIS).
 *
 * Tie-breaking rule: among all longest strictly increasing subsequences, the
 * one whose INDEX sequence is lexicographically smallest is returned.
 * Value order is never used as a substitute for index order.
 *
 * The result is returned as an index certificate that can be verified
 * independently against the sequence.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SequenceLibrary = void 0;
exports.lisLength = lisLength;
exports.computeLisCertificate = computeLisCertificate;
exports.verifyCertificate = verifyCertificate;
/** Coordinate-compress values to ranks 1..m (order-preserving). */
function compress(values) {
    const uniq = [...new Set(values)].sort((a, b) => a - b);
    const rankOf = new Map();
    for (let i = 0; i < uniq.length; i++)
        rankOf.set(uniq[i], i + 1);
    return { ranks: values.map((v) => rankOf.get(v)), m: uniq.length };
}
/**
 * Independent O(n log n) length oracle (patience sorting). Used to certify
 * the `length` field of a certificate without trusting the main algorithm.
 */
function lisLength(values) {
    const tails = [];
    for (const v of values) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tails[mid] < v)
                lo = mid + 1;
            else
                hi = mid;
        }
        tails[lo] = v;
    }
    return tails.length;
}
/**
 * Compute the LIS certificate with index-lexicographic tie-breaking.
 *
 * Algorithm:
 *  1. lisFrom[i] = length of the longest strictly increasing subsequence
 *     that starts at index i (computed right-to-left with a Fenwick tree
 *     over compressed values, querying ranks strictly greater than a[i]).
 *  2. Greedy reconstruction: for the k-th element, pick the SMALLEST index
 *     i greater than the previous pick with a[i] > previous value and
 *     lisFrom[i] === remaining length. Such an i always exists, and choosing
 *     the smallest feasible index at every position yields the
 *     lexicographically smallest index sequence (exchange argument: any LIS
 *     with a smaller index at the first differing position would have been
 *     feasible and chosen instead).
 *
 * Note: the classical "smallest tail values" reconstruction minimizes the
 * VALUE sequence, not the index sequence, and is deliberately not used.
 */
function computeLisCertificate(values) {
    const n = values.length;
    if (n === 0)
        return { length: 0, indices: [], values: [] };
    const { ranks, m } = compress(values);
    const bit = new Array(m + 2).fill(0);
    const bitUpdate = (pos, val) => {
        for (let i = pos; i <= m; i += i & -i)
            if (val > bit[i])
                bit[i] = val;
    };
    const bitQuery = (pos) => {
        let best = 0;
        for (let i = pos; i > 0; i -= i & -i)
            if (bit[i] > best)
                best = bit[i];
        return best;
    };
    // Fenwick tree keyed by reversed rank so "values > a[i]" becomes a prefix max.
    const lisFrom = new Array(n);
    let total = 0;
    for (let i = n - 1; i >= 0; i--) {
        const rev = m - ranks[i] + 1;
        lisFrom[i] = bitQuery(rev - 1) + 1;
        bitUpdate(rev, lisFrom[i]);
        if (lisFrom[i] > total)
            total = lisFrom[i];
    }
    const indices = [];
    let remaining = total;
    let prevValue = -Infinity;
    let start = 0;
    while (remaining > 0) {
        for (let i = start; i < n; i++) {
            if (values[i] > prevValue && lisFrom[i] === remaining) {
                indices.push(i);
                prevValue = values[i];
                start = i + 1;
                remaining--;
                break;
            }
        }
    }
    return {
        length: total,
        indices,
        values: indices.map((i) => values[i]),
    };
}
/**
 * Verify an index certificate against a sequence:
 *  - indices are in range and strictly increasing;
 *  - cert.values match the sequence at those indices and strictly increase;
 *  - cert.length is consistent and equals the true LIS length (checked with
 *    the independent patience-sorting oracle).
 */
function verifyCertificate(values, cert) {
    const { length, indices, values: certValues } = cert;
    if (!Number.isInteger(length) || length < 0)
        return false;
    if (indices.length !== length || certValues.length !== length)
        return false;
    for (let k = 0; k < length; k++) {
        const idx = indices[k];
        if (!Number.isInteger(idx) || idx < 0 || idx >= values.length)
            return false;
        if (k > 0 && idx <= indices[k - 1])
            return false;
        if (certValues[k] !== values[idx])
            return false;
        if (k > 0 && certValues[k] <= certValues[k - 1])
            return false;
    }
    return length === lisLength(values);
}
/**
 * A mutable sequence supporting append-at-end and undo, with LIS queries.
 */
class SequenceLibrary {
    data = [];
    /** Append a value at the end. */
    append(value) {
        this.data.push(value);
    }
    /** Remove and return the last appended value. Throws if empty. */
    undo() {
        const v = this.data.pop();
        if (v === undefined)
            throw new RangeError("undo on empty sequence");
        return v;
    }
    get size() {
        return this.data.length;
    }
    /** Current sequence contents (defensive copy). */
    snapshot() {
        return [...this.data];
    }
    /** LIS certificate for the current sequence. */
    lisCertificate() {
        return computeLisCertificate(this.data);
    }
    /** Verify a certificate (defaults to the current one). */
    verify(cert = this.lisCertificate()) {
        return verifyCertificate(this.data, cert);
    }
}
exports.SequenceLibrary = SequenceLibrary;

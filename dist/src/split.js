/**
 * Core split: divide an integer `total` into integer shares, one per
 * recipient, proportionally to rational weights and subject to per-recipient
 * [min, max] bounds.
 *
 * Objective (exact): minimize the sum of squared deviations from the ideal
 * rational shares  q_i = total * w_i / W.  Ties are broken by recipient ID
 * (ascending).  The implementation is a unit-greedy marginal-cost allocator,
 * which for this separable strictly-convex objective is exact and behaves as
 * "largest remainder first; saturated recipients exit; equal remainders go
 * to the smaller ID".
 */
export class InfeasibleError extends Error {
    constructor(message) {
        super(message);
        this.name = "InfeasibleError";
    }
}
export function compareIds(a, b) {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function gcd(a, b) {
    if (a < 0n)
        a = -a;
    if (b < 0n)
        b = -b;
    while (b !== 0n) {
        const t = a % b;
        a = b;
        b = t;
    }
    return a;
}
/** Parse a JS number as the exact decimal rational it prints as ("0.1" -> 1/10). */
function numberToRational(value) {
    if (!Number.isFinite(value)) {
        throw new Error(`invalid numeric weight: ${value}`);
    }
    if (Number.isInteger(value))
        return [BigInt(value), 1n];
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
    if (!m)
        throw new Error(`invalid numeric weight: ${value}`);
    const sign = m[1] === "-" ? -1n : 1n;
    const digits = (m[2] ?? "") + (m[3] ?? "");
    const exp = Number(m[4] ?? "0") - (m[3] ?? "").length;
    let num = sign * BigInt(digits);
    let den = 1n;
    if (exp >= 0)
        num *= 10n ** BigInt(exp);
    else
        den = 10n ** BigInt(-exp);
    const g = gcd(num, den);
    return [num / g, den / g];
}
function toRational(w) {
    if (typeof w === "bigint")
        return [w, 1n];
    if (typeof w === "number")
        return numberToRational(w);
    let num = BigInt(w.num);
    let den = BigInt(w.den);
    if (den === 0n)
        throw new Error("weight denominator must be non-zero");
    if (den < 0n) {
        num = -num;
        den = -den;
    }
    const g = gcd(num, den);
    return [num / g, den / g];
}
function normalize(recipients, total) {
    if (!Number.isInteger(total) || total < 0) {
        throw new Error(`total must be a non-negative integer, got ${total}`);
    }
    const seen = new Set();
    const raws = recipients.map((r) => {
        if (seen.has(r.id)) {
            throw new Error(`duplicate recipient id: ${String(r.id)}`);
        }
        seen.add(r.id);
        const min = r.min ?? 0;
        const rawMax = r.max ?? total;
        if (!Number.isInteger(min) || !Number.isInteger(rawMax) || min < 0 || rawMax < min) {
            throw new Error(`invalid bounds for recipient ${String(r.id)}: min=${r.min}, max=${r.max}`);
        }
        const max = Math.min(rawMax, total);
        const [num, den] = toRational(r.weight);
        if (num < 0n) {
            throw new Error(`negative weight for recipient ${String(r.id)}`);
        }
        return { id: r.id, num, den, min, max };
    });
    let lcm = 1n;
    for (const r of raws)
        lcm = (lcm / gcd(lcm, r.den)) * r.den;
    return raws
        .map((r) => ({ id: r.id, w: r.num * (lcm / r.den), min: r.min, max: r.max }))
        .sort((a, b) => compareIds(a.id, b.id));
}
/**
 * Exact squared-deviation cost of an allocation, scaled by W^2 (a common
 * positive factor), so comparisons are exact integer comparisons.
 * When all weights are zero the ideal share is defined as 0 for everyone.
 */
export function squaredDeviation(total, recipients, allocation) {
    const rs = normalize(recipients, total);
    const byId = new Map();
    if (Array.isArray(allocation)) {
        for (const e of allocation)
            byId.set(e.id, e.amount);
    }
    else {
        for (const [id, amount] of allocation)
            byId.set(id, amount);
    }
    const amountOf = (id) => {
        const v = byId.get(id);
        if (v === undefined)
            throw new Error(`missing allocation for ${String(id)}`);
        return v;
    };
    const W = rs.reduce((s, r) => s + r.w, 0n);
    const T = BigInt(total);
    let sum = 0n;
    for (const r of rs) {
        const x = BigInt(amountOf(r.id));
        const d = W > 0n ? x * W - T * r.w : x;
        sum += d * d;
    }
    return sum;
}
/** Split `total`; returns entries sorted by recipient ID. */
export function splitDetailed(total, recipients) {
    const rs = normalize(recipients, total);
    let minSum = 0;
    let maxSum = 0;
    for (const r of rs) {
        minSum += r.min;
        maxSum += r.max;
    }
    if (minSum > total) {
        throw new InfeasibleError(`sum of minimums (${minSum}) exceeds total (${total})`);
    }
    if (maxSum < total) {
        throw new InfeasibleError(`sum of maximums (${maxSum}) is below total (${total})`);
    }
    const W = rs.reduce((s, r) => s + r.w, 0n);
    const T = BigInt(total);
    const x = rs.map((r) => r.min);
    let remaining = total - minSum;
    while (remaining > 0) {
        // Give one unit to the non-saturated recipient with the smallest
        // marginal cost  2*(x_i - q_i) + 1  (exact, scaled by W).
        // Recipients are ID-sorted, so strict "<" keeps the smaller ID on ties.
        let best = -1;
        let bestCost = 0n;
        for (let i = 0; i < rs.length; i++) {
            const r = rs[i];
            if (x[i] >= r.max)
                continue; // saturated -> exits
            const cost = W > 0n
                ? 2n * (BigInt(x[i]) * W - T * r.w) + W
                : 2n * BigInt(x[i]) + 1n;
            if (best < 0 || cost < bestCost) {
                best = i;
                bestCost = cost;
            }
        }
        if (best < 0) {
            throw new InfeasibleError("no recipient can absorb the remaining amount");
        }
        x[best]++;
        remaining--;
    }
    return rs.map((r, i) => ({ id: r.id, amount: x[i] }));
}
/** Split `total`; returns a Map from recipient ID to integer share. */
export function split(total, recipients) {
    return new Map(splitDetailed(total, recipients).map((e) => [e.id, e.amount]));
}

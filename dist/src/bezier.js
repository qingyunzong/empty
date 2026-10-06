"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.binom = binom;
exports.bernsteinToPower = bernsteinToPower;
exports.powerToBernstein = powerToBernstein;
exports.signVariation = signVariation;
exports.subdivideHalf = subdivideHalf;
const rational_1 = require("./rational");
const poly_1 = require("./poly");
function binom(n, k) {
    if (k < 0 || k > n)
        return 0n;
    let r = 1n;
    for (let i = 0; i < k; i++) {
        r = (r * BigInt(n - i)) / BigInt(i + 1);
    }
    return r;
}
/** Convert Bernstein coefficients (degree n = b.length - 1) to power basis. */
function bernsteinToPower(b) {
    const n = b.length - 1;
    const out = Array.from({ length: n + 1 }, () => rational_1.Rat.zero());
    for (let i = 0; i <= n; i++) {
        const ci = binom(n, i);
        for (let k = i; k <= n; k++) {
            const sign = (k - i) % 2 === 0 ? 1n : -1n;
            const term = b[i].mul(rational_1.Rat.of(sign * ci * binom(n - i, k - i)));
            out[k] = out[k].add(term);
        }
    }
    return (0, poly_1.trim)(out);
}
/** Convert power-basis polynomial of degree <= n to Bernstein coefficients of degree n. */
function powerToBernstein(p, n) {
    const out = Array.from({ length: n + 1 }, () => rational_1.Rat.zero());
    for (let k = 0; k < p.length; k++) {
        for (let i = k; i <= n; i++) {
            const coeff = rational_1.Rat.of(binom(i, k), binom(n, k));
            out[i] = out[i].add(p[k].mul(coeff));
        }
    }
    return out;
}
/** Number of sign changes in the sequence, ignoring zeros (Descartes / Bernstein variation). */
function signVariation(c) {
    let v = 0;
    let prev = 0;
    for (const x of c) {
        const s = x.sign();
        if (s === 0)
            continue;
        if (prev !== 0 && s !== prev)
            v++;
        prev = s;
    }
    return v;
}
/** Exact de Casteljau split of Bernstein coefficients at the interval midpoint (u = 1/2). */
function subdivideHalf(b) {
    const n = b.length - 1;
    const half = rational_1.Rat.of(1n, 2n);
    const left = [];
    const right = [];
    let level = b.slice();
    left.push(level[0]);
    right.unshift(level[level.length - 1]);
    for (let r = 1; r <= n; r++) {
        const next = [];
        for (let i = 0; i < level.length - 1; i++) {
            next.push(level[i].mul(half).add(level[i + 1].mul(half)));
        }
        level = next;
        left.push(level[0]);
        right.unshift(level[level.length - 1]);
    }
    return [left, right];
}

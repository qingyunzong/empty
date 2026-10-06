"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trim = trim;
exports.deg = deg;
exports.isZeroPoly = isZeroPoly;
exports.evalPoly = evalPoly;
exports.deriv = deriv;
exports.addPoly = addPoly;
exports.subPoly = subPoly;
exports.scalePoly = scalePoly;
exports.mulPoly = mulPoly;
exports.divmodPoly = divmodPoly;
exports.divExact = divExact;
exports.gcdPoly = gcdPoly;
exports.multiplicityAt = multiplicityAt;
const rational_1 = require("./rational");
function trim(p) {
    let end = p.length;
    while (end > 0 && p[end - 1].isZero())
        end--;
    return p.slice(0, end);
}
function deg(p) {
    return trim(p).length - 1;
}
function isZeroPoly(p) {
    return trim(p).length === 0;
}
function evalPoly(p, x) {
    let acc = rational_1.Rat.zero();
    for (let i = p.length - 1; i >= 0; i--)
        acc = acc.mul(x).add(p[i]);
    return acc;
}
function deriv(p) {
    const out = [];
    for (let i = 1; i < p.length; i++)
        out.push(p[i].mul(rational_1.Rat.of(i)));
    return trim(out);
}
function addPoly(a, b) {
    const n = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < n; i++) {
        const x = i < a.length ? a[i] : rational_1.Rat.zero();
        const y = i < b.length ? b[i] : rational_1.Rat.zero();
        out.push(x.add(y));
    }
    return trim(out);
}
function subPoly(a, b) {
    const n = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < n; i++) {
        const x = i < a.length ? a[i] : rational_1.Rat.zero();
        const y = i < b.length ? b[i] : rational_1.Rat.zero();
        out.push(x.sub(y));
    }
    return trim(out);
}
function scalePoly(p, s) {
    return trim(p.map((c) => c.mul(s)));
}
function mulPoly(a, b) {
    if (isZeroPoly(a) || isZeroPoly(b))
        return [];
    const out = Array.from({ length: a.length + b.length - 1 }, () => rational_1.Rat.zero());
    for (let i = 0; i < a.length; i++)
        for (let j = 0; j < b.length; j++)
            out[i + j] = out[i + j].add(a[i].mul(b[j]));
    return trim(out);
}
/** Exact polynomial division over the rationals. Returns [quotient, remainder]. */
function divmodPoly(a, b) {
    const dividend = trim(a).slice();
    const divisor = trim(b);
    if (divisor.length === 0)
        throw new Error("polynomial division by zero");
    const q = Array.from({ length: Math.max(0, dividend.length - divisor.length + 1) }, () => rational_1.Rat.zero());
    let rem = dividend;
    while (rem.length >= divisor.length && rem.length > 0) {
        const shift = rem.length - divisor.length;
        const factor = rem[rem.length - 1].div(divisor[divisor.length - 1]);
        q[shift] = factor;
        const sub = Array.from({ length: shift }, () => rational_1.Rat.zero());
        for (let i = 0; i < divisor.length; i++)
            sub.push(divisor[i].mul(factor));
        rem = trim(subPoly(rem, sub));
    }
    return [trim(q), trim(rem)];
}
function divExact(a, b) {
    const [q, r] = divmodPoly(a, b);
    if (!isZeroPoly(r))
        throw new Error("expected exact polynomial division");
    return q;
}
/** Monic greatest common divisor of two polynomials over the rationals. */
function gcdPoly(a, b) {
    let x = trim(a);
    let y = trim(b);
    if (x.length === 0)
        return y;
    if (y.length === 0)
        return x;
    while (y.length > 0) {
        const [, r] = divmodPoly(x, y);
        x = y;
        y = r;
    }
    const lc = x[x.length - 1];
    return scalePoly(x, rational_1.Rat.one().div(lc));
}
/** Order of vanishing of p at x (0 if p(x) != 0). Exact. */
function multiplicityAt(p, x) {
    if (isZeroPoly(p))
        throw new Error("zero polynomial has infinite multiplicity");
    let m = 0;
    let cur = trim(p);
    const linear = [x.neg(), rational_1.Rat.one()];
    while (cur.length > 0 && evalPoly(cur, x).isZero()) {
        m++;
        cur = divExact(cur, linear);
    }
    return m;
}

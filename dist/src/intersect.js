"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.intersectEllipseLine = intersectEllipseLine;
const rational_1 = require("./rational");
const algebraic_1 = require("./algebraic");
/** Quadratic p t^2 + q t + r with rational coefficients (exact). */
class Quadratic {
    p;
    q;
    r;
    constructor(p, q, r) {
        this.p = p;
        this.q = q;
        this.r = r;
    }
    eval(t) {
        return this.p.mul(t).mul(t).add(this.q.mul(t)).add(this.r);
    }
    discriminant() {
        return this.q.mul(this.q).sub(rational_1.Rat.of(4).mul(this.p).mul(this.r));
    }
}
const DEFAULT_EPS = rational_1.Rat.of(1, 1 << 20); // max isolating-interval width
/**
 * Intersect a non-degenerate real ellipse with a rational line, exactly.
 *
 * The line is parametrized by one coordinate (t = x if b != 0, else t = y),
 * substituted into the conic to get a rational quadratic. Its exact
 * discriminant decides none / tangent / two intersections. Roots are
 * reported as algebraic numbers  rat + coeff*sqrt(disc)  plus rational
 * isolating intervals obtained by exact-sign bisection, then verified by
 * substituting the interval endpoints back into the original 2D conic.
 */
function intersectEllipseLine(ellipse, line, eps = DEFAULT_EPS) {
    if (eps.sign() <= 0)
        throw new Error("eps must be positive");
    // Parametrize: if b != 0 use t = x, y = alpha t + beta; else t = y, x = beta.
    const useX = !line.b.isZero();
    const alpha = useX ? line.a.neg().div(line.b) : rational_1.Rat.ZERO;
    const beta = useX ? line.c.neg().div(line.b) : line.c.neg().div(line.a);
    // Substitute into A x^2 + B x y + C y^2 + D x + E y + F.
    const { A, B, C, D, E, F } = ellipse;
    let p, q, r;
    if (useX) {
        p = A.add(B.mul(alpha)).add(C.mul(alpha).mul(alpha));
        q = B.mul(beta).add(C.mul(rational_1.Rat.of(2)).mul(alpha).mul(beta)).add(D).add(E.mul(alpha));
        r = C.mul(beta).mul(beta).add(E.mul(beta)).add(F);
    }
    else {
        p = C;
        q = B.mul(beta).add(E);
        r = A.mul(beta).mul(beta).add(D.mul(beta)).add(F);
    }
    const quad = new Quadratic(p, q, r);
    // For a real ellipse the quadratic part is definite, so p != 0 always.
    if (p.isZero())
        throw new Error("internal: degenerate substitution");
    const disc = quad.discriminant();
    const toPoint = (t, tInterval) => {
        const other = t.affine(alpha, beta);
        return useX
            ? { x: t, y: other, tInterval }
            : { x: other, y: t, tInterval };
    };
    if (disc.sign() < 0) {
        return { kind: "none", discriminant: disc };
    }
    const two = rational_1.Rat.of(2);
    const vertex = q.neg().div(two.mul(p)); // -q / (2p), midpoint of the roots
    if (disc.isZero()) {
        // Tangent: the root is rational, t = -q/(2p). Verify exactly.
        const point = toPoint(algebraic_1.AlgNum.rational(vertex), { lo: vertex, hi: vertex });
        const px = point.x.rat, py = point.y.rat;
        if (!ellipse.eval(px, py).isZero() || !line.eval(px, py).isZero()) {
            throw new Error("internal: tangent point failed exact verification");
        }
        return { kind: "tangent", discriminant: disc, point };
    }
    // Two distinct roots: t = vertex +/- (1/(2p)) * sqrt(disc).
    const coeff = rational_1.Rat.ONE.div(two.mul(p)); // may be negative; sign carried per root
    const tLower = algebraic_1.AlgNum.of(vertex, coeff.abs().neg(), disc);
    const tUpper = algebraic_1.AlgNum.of(vertex, coeff.abs(), disc);
    // Isolating intervals via exact-sign bisection from the vertex outward.
    const sgnLead = p.sign(); // sign of f outside the roots
    const isolateOutward = (from, dir) => {
        // Move outward until f has the leading sign (we passed the root).
        let step = rational_1.Rat.ONE;
        let outer = from.add(dir === 1 ? step : step.neg());
        while (quad.eval(outer).sign() !== sgnLead) {
            step = step.mul(two);
            outer = from.add(dir === 1 ? step : step.neg());
        }
        let lo = dir === 1 ? from : outer;
        let hi = dir === 1 ? outer : from;
        // Invariant: f(lo) and f(hi) have opposite signs, single root inside.
        while (hi.sub(lo).cmp(eps) > 0) {
            const mid = lo.add(hi).div(two);
            const s = quad.eval(mid).sign();
            if (s === 0) {
                // Bisection landed exactly on a (rational) root. The other root is
                // 2*vertex - mid; take a small symmetric interval that cannot reach
                // it, so the endpoint signs still straddle zero.
                const other = vertex.mul(two).sub(mid);
                let half = mid.sub(other).abs().div(rational_1.Rat.of(4));
                const cap = eps.div(two);
                if (half.cmp(cap) > 0)
                    half = cap;
                return { lo: mid.sub(half), hi: mid.add(half) };
            }
            if (dir === 1) {
                if (s === sgnLead)
                    hi = mid;
                else
                    lo = mid;
            }
            else {
                if (s === sgnLead)
                    lo = mid;
                else
                    hi = mid;
            }
        }
        return { lo, hi };
    };
    const ivLo = isolateOutward(vertex, -1);
    const ivHi = isolateOutward(vertex, +1);
    // Substitute-back verification: evaluate the ORIGINAL 2D conic at the
    // rational endpoint points of each isolating interval; signs must straddle
    // zero, and the intervals must be disjoint (each isolates exactly one root).
    verifyInterval(ellipse, useX, alpha, beta, ivLo);
    verifyInterval(ellipse, useX, alpha, beta, ivHi);
    if (ivLo.hi.cmp(ivHi.lo) >= 0) {
        throw new Error("internal: isolating intervals overlap");
    }
    return {
        kind: "two",
        discriminant: disc,
        points: [toPoint(tLower, ivLo), toPoint(tUpper, ivHi)],
    };
}
/** Exact substitute-back check: F(point(t)) at both interval endpoints must
 *  have opposite (nonzero) signs, proving exactly one root lies inside. */
function verifyInterval(ellipse, useX, alpha, beta, iv) {
    const at = (t) => {
        const o = alpha.mul(t).add(beta);
        return useX ? ellipse.eval(t, o) : ellipse.eval(o, t);
    };
    const slo = at(iv.lo).sign();
    const shi = at(iv.hi).sign();
    if (slo === 0 || shi === 0 || slo === shi) {
        throw new Error("internal: isolating interval failed substitute-back verification");
    }
}

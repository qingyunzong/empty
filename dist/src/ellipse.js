"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Line = exports.Ellipse = void 0;
const rational_1 = require("./rational");
/** General conic  A x^2 + B x y + C y^2 + D x + E y + F = 0  with rational
 *  coefficients. Construction goes through Ellipse.create, which rejects
 *  anything that is not a non-degenerate real ellipse. */
class Ellipse {
    A;
    B;
    C;
    D;
    E;
    F;
    constructor(A, B, C, D, E, F) {
        this.A = A;
        this.B = B;
        this.C = C;
        this.D = D;
        this.E = E;
        this.F = F;
    }
    /** Evaluate the conic polynomial at a rational point (exact). */
    eval(x, y) {
        const { A, B, C, D, E, F } = this;
        return A.mul(x).mul(x)
            .add(B.mul(x).mul(y))
            .add(C.mul(y).mul(y))
            .add(D.mul(x))
            .add(E.mul(y))
            .add(F);
    }
    /**
     * Validate and build an ellipse. Throws on:
     *  - non-ellipse type (B^2 - 4AC >= 0: parabola/hyperbola or no quadratic part)
     *  - degenerate conic (det of the 3x3 matrix = 0: point ellipse, intersecting
     *    or parallel lines, etc.)
     *  - imaginary ellipse (det != 0 but no real locus, e.g. x^2 + y^2 + 1 = 0)
     */
    static create(A, B, C, D, E, F) {
        const two = rational_1.Rat.of(2), four = rational_1.Rat.of(4);
        const disc2 = B.mul(B).sub(four.mul(A).mul(C)); // B^2 - 4AC
        if (disc2.sign() >= 0) {
            throw new Error(`not an ellipse: B^2-4AC = ${disc2} >= 0`);
        }
        // 3x3 matrix [[A, B/2, D/2], [B/2, C, E/2], [D/2, E/2, F]]
        const hB = B.div(two), hD = D.div(two), hE = E.div(two);
        const det = A.mul(C).mul(F)
            .add(hB.mul(hE).mul(hD))
            .add(hD.mul(hB).mul(hE))
            .sub(hD.mul(C).mul(hD))
            .sub(hB.mul(hB).mul(F))
            .sub(A.mul(hE).mul(hE));
        if (det.isZero()) {
            throw new Error("degenerate ellipse: determinant of conic matrix is zero");
        }
        // For B^2-4AC < 0 and det != 0 the locus is a real ellipse iff
        // det * (A + C) < 0; det * (A + C) > 0 gives an imaginary ellipse.
        if (det.mul(A.add(C)).sign() > 0) {
            throw new Error("imaginary ellipse: no real points");
        }
        return new Ellipse(A, B, C, D, E, F);
    }
}
exports.Ellipse = Ellipse;
/** Rational line  a x + b y + c = 0  with (a, b) != (0, 0). */
class Line {
    a;
    b;
    c;
    constructor(a, b, c) {
        if (a.isZero() && b.isZero())
            throw new Error("degenerate line: a = b = 0");
        this.a = a;
        this.b = b;
        this.c = c;
    }
    eval(x, y) {
        return this.a.mul(x).add(this.b.mul(y)).add(this.c);
    }
}
exports.Line = Line;

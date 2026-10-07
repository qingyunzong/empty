"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const rational_1 = require("../src/rational");
const ellipse_1 = require("../src/ellipse");
const intersect_1 = require("../src/intersect");
const R = (s) => typeof s === "string" ? rational_1.Rat.parse(s) : rational_1.Rat.of(s);
function ellipse(c) {
    return ellipse_1.Ellipse.create(...c.map(R));
}
function line(c) {
    const [a, b, cc] = c.map(R);
    return new ellipse_1.Line(a, b, cc);
}
const EPS = rational_1.Rat.of(1, 1 << 20);
/** Independent substitute-back check used by the acceptance tests:
 *  the original 2D conic, evaluated at the rational endpoint points of the
 *  isolating interval, must straddle zero; and the algebraic coordinates
 *  must lie inside the interval (numerically) and on the line. */
function checkPointOnEllipse(e, l, pt, eps) {
    const { lo, hi } = pt.tInterval;
    strict_1.default.ok(lo.cmp(hi) <= 0, "interval endpoints ordered");
    strict_1.default.ok(hi.sub(lo).cmp(eps) <= 0, `interval width ${hi.sub(lo)} <= eps`);
    const useX = !l.b.isZero();
    const tApprox = useX ? pt.x.approx() : pt.y.approx();
    strict_1.default.ok(lo.toNumber() <= tApprox && tApprox <= hi.toNumber(), `t approx ${tApprox} inside [${lo}, ${hi}]`);
    const lineVal = l.a.toNumber() * pt.x.approx() + l.b.toNumber() * pt.y.approx() + l.c.toNumber();
    strict_1.default.ok(Math.abs(lineVal) < 1e-9, `point on line, got ${lineVal}`);
    const at = (t) => {
        if (useX) {
            const y = l.a.neg().div(l.b).mul(t).add(l.c.neg().div(l.b));
            return e.eval(t, y);
        }
        const x = l.c.neg().div(l.a);
        return e.eval(x, t);
    };
    const slo = at(lo).sign();
    const shi = at(hi).sign();
    strict_1.default.notEqual(slo, 0);
    strict_1.default.notEqual(shi, 0);
    strict_1.default.notEqual(slo, shi, "conic straddles zero over isolating interval");
}
(0, node_test_1.test)("Rat normalizes and parses", () => {
    strict_1.default.equal(rational_1.Rat.parse("6/8").toString(), "3/4");
    strict_1.default.equal(rational_1.Rat.parse("-2/-4").toString(), "1/2");
    strict_1.default.equal(rational_1.Rat.parse("3/-4").toString(), "-3/4");
    strict_1.default.equal(rational_1.Rat.parse("0/7").toString(), "0");
    strict_1.default.equal(R("2").add(R("1/3")).toString(), "7/3");
    strict_1.default.equal(R("1/2").mul(R("-4/5")).toString(), "-2/5");
    strict_1.default.equal(R("3/4").div(R("9/8")).toString(), "2/3");
    strict_1.default.throws(() => rational_1.Rat.of(1, 0));
});
(0, node_test_1.test)("rejects degenerate and non-ellipse conics", () => {
    // point ellipse x^2 + y^2 = 0: det = 0
    strict_1.default.throws(() => ellipse(["1", "0", "1", "0", "0", "0"]), /degenerate/);
    // pair of lines (x+y)(x-y) = 0 type scaled to ellipse-looking is caught by
    // type check; here a genuine degenerate: x^2 + 2xy + y^2 - 1 = 0 (parallel lines)
    strict_1.default.throws(() => ellipse(["1", "2", "1", "0", "0", "-1"]), /not an ellipse/);
    // hyperbola x^2 - y^2 = 1
    strict_1.default.throws(() => ellipse(["1", "0", "-1", "0", "0", "-1"]), /not an ellipse/);
    // parabola y = x^2 -> x^2 - y = 0
    strict_1.default.throws(() => ellipse(["1", "0", "0", "0", "-1", "0"]), /not an ellipse/);
    // imaginary ellipse x^2 + y^2 + 1 = 0
    strict_1.default.throws(() => ellipse(["1", "0", "1", "0", "0", "1"]), /imaginary/);
    // no quadratic part
    strict_1.default.throws(() => ellipse(["0", "0", "0", "1", "1", "1"]), /not an ellipse/);
    // degenerate line
    strict_1.default.throws(() => new ellipse_1.Line(rational_1.Rat.ZERO, rational_1.Rat.ZERO, R("1")), /degenerate line/);
});
(0, node_test_1.test)("acceptance: known tangent to circle x^2 + y^2 = 2 at (1,1)", () => {
    const e = ellipse(["1", "0", "1", "0", "0", "-2"]);
    const l = line(["1", "1", "-2"]); // x + y = 2
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "tangent");
    strict_1.default.ok(res.discriminant.isZero());
    if (res.kind !== "tangent")
        return;
    strict_1.default.ok(res.point.x.isRational() && res.point.y.isRational());
    strict_1.default.equal(res.point.x.rat.toString(), "1");
    strict_1.default.equal(res.point.y.rat.toString(), "1");
    // exact: point satisfies both equations
    strict_1.default.ok(e.eval(R("1"), R("1")).isZero());
    strict_1.default.ok(l.eval(R("1"), R("1")).isZero());
});
(0, node_test_1.test)("acceptance: known tangent 3x + 8y = 10 to ellipse x^2 + 4y^2 = 4", () => {
    const e = ellipse(["1", "0", "4", "0", "0", "-4"]);
    const l = line(["3", "8", "-10"]);
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "tangent");
    if (res.kind !== "tangent")
        return;
    strict_1.default.equal(res.point.x.rat.toString(), "6/5");
    strict_1.default.equal(res.point.y.rat.toString(), "4/5");
});
(0, node_test_1.test)("acceptance: horizontal tangent y = 1 to ellipse x^2 + 4y^2 = 4", () => {
    const e = ellipse(["1", "0", "4", "0", "0", "-4"]);
    const l = line(["0", "1", "-1"]);
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "tangent");
    if (res.kind !== "tangent")
        return;
    strict_1.default.equal(res.point.x.rat.toString(), "0");
    strict_1.default.equal(res.point.y.rat.toString(), "1");
});
(0, node_test_1.test)("two irrational intersections: circle x^2+y^2=4 with y=x", () => {
    const e = ellipse(["1", "0", "1", "0", "0", "-4"]);
    const l = line(["1", "-1", "0"]); // y = x
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "two");
    strict_1.default.ok(res.discriminant.gt(rational_1.Rat.ZERO));
    if (res.kind !== "two")
        return;
    const [p1, p2] = res.points;
    // x = -sqrt(2) and x = +sqrt(2)
    strict_1.default.ok(p1.x.rat.isZero());
    strict_1.default.equal(p1.x.coeff.toString(), "-1/4");
    strict_1.default.equal(p1.x.radicand.toString(), "32");
    strict_1.default.ok(p2.x.rat.isZero());
    strict_1.default.equal(p2.x.coeff.toString(), "1/4");
    strict_1.default.equal(p2.x.radicand.toString(), "32");
    strict_1.default.ok(Math.abs(p1.x.approx() + Math.SQRT2) < 1e-12);
    strict_1.default.ok(Math.abs(p2.x.approx() - Math.SQRT2) < 1e-12);
    // intervals isolate and verify by substitute-back
    checkPointOnEllipse(e, l, p1, EPS);
    checkPointOnEllipse(e, l, p2, EPS);
    strict_1.default.ok(p1.tInterval.hi.cmp(p2.tInterval.lo) < 0, "intervals disjoint");
});
(0, node_test_1.test)("two rational intersections: x^2 + xy + y^2 = 1 with y = 0", () => {
    const e = ellipse(["1", "1", "1", "0", "0", "-1"]);
    const l = line(["0", "1", "0"]);
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "two");
    if (res.kind !== "two")
        return;
    const [p1, p2] = res.points;
    strict_1.default.ok(Math.abs(p1.x.approx() + 1) < 1e-9);
    strict_1.default.ok(Math.abs(p2.x.approx() - 1) < 1e-9);
    checkPointOnEllipse(e, l, p1, EPS);
    checkPointOnEllipse(e, l, p2, EPS);
});
(0, node_test_1.test)("vertical line (b = 0) path: x = 1 cuts circle x^2+y^2=4 at y = +/-sqrt(3)", () => {
    const e = ellipse(["1", "0", "1", "0", "0", "-4"]);
    const l = line(["1", "0", "-1"]);
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "two");
    if (res.kind !== "two")
        return;
    const [p1, p2] = res.points;
    strict_1.default.equal(p1.x.rat.toString(), "1");
    strict_1.default.equal(p2.x.rat.toString(), "1");
    strict_1.default.equal(p1.y.radicand.toString(), "12");
    strict_1.default.equal(p2.y.radicand.toString(), "12");
    strict_1.default.ok(Math.abs(p1.y.approx() + Math.sqrt(3)) < 1e-12);
    strict_1.default.ok(Math.abs(p2.y.approx() - Math.sqrt(3)) < 1e-12);
    checkPointOnEllipse(e, l, p1, EPS);
    checkPointOnEllipse(e, l, p2, EPS);
});
(0, node_test_1.test)("no intersection: circle x^2+y^2=1 and line x=2", () => {
    const e = ellipse(["1", "0", "1", "0", "0", "-1"]);
    const l = line(["1", "0", "-2"]);
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "none");
    strict_1.default.ok(res.discriminant.lt(rational_1.Rat.ZERO));
});
(0, node_test_1.test)("translated/rotated ellipse with rational line, exact discriminant", () => {
    // Ellipse (x-1)^2/4 + (y+1)^2 = 1  ->  x^2 + 4y^2 - 2x + 8y + 1 = 0
    const e = ellipse(["1", "0", "4", "-2", "8", "1"]);
    // Line y = x - 1 passes through center (1,-1): two symmetric intersections.
    const l = line(["1", "-1", "-1"]);
    const res = (0, intersect_1.intersectEllipseLine)(e, l);
    strict_1.default.equal(res.kind, "two");
    if (res.kind !== "two")
        return;
    // Substituting gives 5x^2 - 2x - 3 = 0, disc = 4 + 60 = 64.
    strict_1.default.equal(res.discriminant.toString(), "64");
    const [p1, p2] = res.points;
    // Exact form: vertex 1/5, coeff 1/10, radicand 64 (roots 1 and -3/5).
    strict_1.default.equal(p1.x.rat.toString(), "1/5");
    strict_1.default.equal(p1.x.radicand.toString(), "64");
    strict_1.default.ok(Math.abs(p1.x.approx() + 3 / 5) < 1e-12);
    strict_1.default.ok(Math.abs(p2.x.approx() - 1) < 1e-12);
    checkPointOnEllipse(e, l, p1, EPS);
    checkPointOnEllipse(e, l, p2, EPS);
});
(0, node_test_1.test)("custom eps controls isolating interval width", () => {
    const e = ellipse(["1", "0", "1", "0", "0", "-4"]);
    const l = line(["1", "-1", "0"]);
    const tight = rational_1.Rat.of(1, 1 << 30);
    const res = (0, intersect_1.intersectEllipseLine)(e, l, tight);
    strict_1.default.equal(res.kind, "two");
    if (res.kind !== "two")
        return;
    for (const p of res.points) {
        strict_1.default.ok(p.tInterval.hi.sub(p.tInterval.lo).cmp(tight) <= 0);
        checkPointOnEllipse(e, l, p, tight);
    }
});

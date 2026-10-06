"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const rational_1 = require("../src/rational");
const poly_1 = require("../src/poly");
const bezier_1 = require("../src/bezier");
const solve_1 = require("../src/solve");
const cli_1 = require("../src/cli");
const LINE_Y0 = { a: rational_1.Rat.zero(), b: rational_1.Rat.one(), c: rational_1.Rat.zero() };
/** Cubic Bezier segment with x(t) = t and y(t) = p(t) for a power-basis poly p (deg <= 3). */
function segmentFromYPoly(p) {
    const y = (0, bezier_1.powerToBernstein)(p, 3);
    return [0, 1, 2, 3].map((i) => [rational_1.Rat.of(i, 3), y[i]]);
}
function lin(r) {
    return [(0, rational_1.parseRat)(r).neg(), rational_1.Rat.one()]; // t - r
}
function mulAll(ps) {
    return ps.reduce((acc, p) => (0, poly_1.mulPoly)(acc, p), [rational_1.Rat.one()]);
}
function knownRootCheck(result, known, segment = 0) {
    for (const { r, mult } of known) {
        const want = (0, rational_1.parseRat)(r);
        const hits = result.roots.filter((root) => {
            if (root.segment !== segment)
                return false;
            const lo = (0, rational_1.parseRat)(root.t[0]);
            const hi = (0, rational_1.parseRat)(root.t[1]);
            return lo.lte(want) && want.lte(hi);
        });
        strict_1.default.equal(hits.length, 1, `root ${r} must be covered by exactly one interval`);
        strict_1.default.equal(hits[0].multiplicity, mult, `root ${r} multiplicity`);
    }
    const total = result.roots
        .filter((root) => root.segment === segment)
        .reduce((s, root) => s + root.multiplicity, 0);
    strict_1.default.equal(total, known.reduce((s, k) => s + k.mult, 0), "no extra or missing roots (sum of multiplicities)");
}
(0, node_test_1.test)("three simple dyadic roots are found exactly with multiplicity 1", () => {
    const p = mulAll([lin("1/4"), lin("1/2"), lin("3/4")]);
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0);
    strict_1.default.equal(res.unknown.length, 0);
    strict_1.default.ok(res.budget.closed);
    knownRootCheck(res, [
        { r: "1/4", mult: 1 },
        { r: "1/2", mult: 1 },
        { r: "3/4", mult: 1 },
    ]);
    for (const root of res.roots)
        strict_1.default.ok(root.exact, "dyadic roots reported exactly");
});
(0, node_test_1.test)("three simple non-dyadic roots are isolated in tight disjoint intervals", () => {
    const p = mulAll([lin("1/3"), lin("2/5"), lin("3/7")]);
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0);
    strict_1.default.equal(res.unknown.length, 0);
    knownRootCheck(res, [
        { r: "1/3", mult: 1 },
        { r: "2/5", mult: 1 },
        { r: "3/7", mult: 1 },
    ]);
    const tol = rational_1.Rat.of(1n, 2n ** 24n);
    const intervals = res.roots.map((root) => [(0, rational_1.parseRat)(root.t[0]), (0, rational_1.parseRat)(root.t[1])]);
    for (const [lo, hi] of intervals) {
        strict_1.default.ok(hi.sub(lo).lte(tol), `interval width within tol: ${lo}..${hi}`);
    }
    intervals.sort((a, b) => a[0].cmp(b[0]));
    for (let i = 1; i < intervals.length; i++) {
        strict_1.default.ok(intervals[i - 1][1].lte(intervals[i][0]), "intervals are disjoint");
    }
});
(0, node_test_1.test)("double root gets multiplicity 2, companion simple root multiplicity 1", () => {
    const p = mulAll([lin("1/2"), lin("1/2"), lin("1/4")]);
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0);
    strict_1.default.equal(res.unknown.length, 0);
    knownRootCheck(res, [
        { r: "1/2", mult: 2 },
        { r: "1/4", mult: 1 },
    ]);
});
(0, node_test_1.test)("triple root gets multiplicity 3", () => {
    const p = mulAll([lin("1/2"), lin("1/2"), lin("1/2")]);
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0);
    strict_1.default.equal(res.roots.length, 1);
    knownRootCheck(res, [{ r: "1/2", mult: 3 }]);
});
(0, node_test_1.test)("double root at endpoint t=0 and simple root at t=1", () => {
    const p = mulAll([lin("0"), lin("0"), lin("1")]);
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0);
    strict_1.default.equal(res.unknown.length, 0);
    knownRootCheck(res, [
        { r: "0", mult: 2 },
        { r: "1", mult: 1 },
    ]);
});
(0, node_test_1.test)("segment lying on the line is reported as an interval", () => {
    const res = (0, solve_1.solve)([segmentFromYPoly([])], LINE_Y0);
    strict_1.default.equal(res.roots.length, 0);
    strict_1.default.deepEqual(res.onLine, [{ segment: 0, t: ["0", "1"], globalT: ["0", "1"] }]);
});
(0, node_test_1.test)("general (non-axis) line: x - y = 0 against y = t^2", () => {
    const seg = segmentFromYPoly([rational_1.Rat.zero(), rational_1.Rat.zero(), rational_1.Rat.one()]); // y = t^2
    const res = (0, solve_1.solve)([seg], { a: rational_1.Rat.one(), b: rational_1.Rat.of(-1), c: rational_1.Rat.zero() });
    knownRootCheck(res, [
        { r: "0", mult: 1 },
        { r: "1", mult: 1 },
    ]);
});
(0, node_test_1.test)("multi-segment spline: roots carry segment-local and global parameters", () => {
    const segs = [
        segmentFromYPoly(lin("1/2")),
        segmentFromYPoly([]), // whole segment on the line
        segmentFromYPoly(mulAll([lin("1/4"), lin("3/4")])),
    ];
    const res = (0, solve_1.solve)(segs, LINE_Y0);
    strict_1.default.equal(res.unknown.length, 0);
    strict_1.default.deepEqual(res.onLine, [{ segment: 1, t: ["0", "1"], globalT: ["1", "2"] }]);
    knownRootCheck(res, [{ r: "1/2", mult: 1 }], 0);
    knownRootCheck(res, [
        { r: "1/4", mult: 1 },
        { r: "3/4", mult: 1 },
    ], 2);
    const globals = res.roots.map((r) => r.globalT);
    strict_1.default.deepEqual(globals, [
        ["1/2", "1/2"],
        ["9/4", "9/4"],
        ["11/4", "11/4"],
    ]);
});
(0, node_test_1.test)("curve with no intersection reports nothing and stays closed", () => {
    // y = t^2 - t + 1/2 > 0 on [0, 1]
    const p = [rational_1.Rat.of(1, 2), rational_1.Rat.of(-1), rational_1.Rat.one()];
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0);
    strict_1.default.equal(res.roots.length, 0);
    strict_1.default.equal(res.onLine.length, 0);
    strict_1.default.equal(res.unknown.length, 0);
    strict_1.default.ok(res.budget.closed);
});
(0, node_test_1.test)("exhausted budget marks unresolved regions as unknown", () => {
    const p = mulAll([lin("1/3"), lin("2/5"), lin("3/7")]);
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0, { budget: 1 });
    strict_1.default.ok(!res.budget.closed);
    strict_1.default.ok(res.unknown.length > 0, "unresolved intervals reported as unknown");
    const bound = res.unknown.reduce((s, u) => s + u.maxRoots, 0);
    strict_1.default.ok(bound >= 3, "unknown intervals still bound the root count");
});
(0, node_test_1.test)("zero budget leaves everything unknown", () => {
    const p = mulAll([lin("1/4"), lin("1/2"), lin("3/4")]);
    const res = (0, solve_1.solve)([segmentFromYPoly(p)], LINE_Y0, { budget: 0 });
    strict_1.default.ok(!res.budget.closed);
    strict_1.default.equal(res.roots.length, 0);
    strict_1.default.ok(res.unknown.length > 0);
});
(0, node_test_1.test)("rejects more than 8 segments", () => {
    const segs = Array.from({ length: 9 }, () => segmentFromYPoly(lin("1/2")));
    strict_1.default.throws(() => (0, solve_1.solve)(segs, LINE_Y0), /8/);
});
(0, node_test_1.test)("CLI end-to-end: triple root at t=1/2 from JSON input", () => {
    const input = {
        segments: [{ points: [[0, -1], [1, 1], [2, -1], [3, 1]] }],
        line: { a: 0, b: 1, c: 0 },
    };
    const res = (0, cli_1.run)(JSON.parse(JSON.stringify(input)));
    strict_1.default.equal(res.roots.length, 1);
    strict_1.default.equal(res.roots[0].multiplicity, 3);
    strict_1.default.deepEqual(res.roots[0].t, ["1/2", "1/2"]);
});

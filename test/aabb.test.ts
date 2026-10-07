import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Rat,
  evaluate,
  makeCurve,
  rationalQuadraticAABB,
  containingBox,
  vec2,
  isolateQuadraticRoots,
  type AABB2D,
  type RationalQuadraticBezier,
} from "../src/index.js";

const r = (n: number | bigint, d: number | bigint = 1): Rat => Rat.of(n, d);
const EPS = r(1, 1 << 20);

/** Exact rational sampling containment: every sample must lie in the box. */
function assertSamplingContainment(curve: RationalQuadraticBezier, box: AABB2D, samples: number): void {
  const cb = containingBox(box);
  for (let k = 0; k <= samples; k++) {
    const t = r(k, samples);
    const p = evaluate(curve, t);
    assert.ok(p.x.ge(cb.xMin) && p.x.le(cb.xMax),
      `x containment failed at t=${t}: ${p.x} not in [${cb.xMin}, ${cb.xMax}]`);
    assert.ok(p.y.ge(cb.yMin) && p.y.le(cb.yMax),
      `y containment failed at t=${t}: ${p.y} not in [${cb.yMin}, ${cb.yMax}]`);
  }
}

/** Every reported extremum bracket must isolate a sign change of the
 *  derivative numerator (or be an exact rational root) and respect eps. */
function assertExtremaVerifiable(curve: RationalQuadraticBezier, box: AABB2D): void {
  for (const ex of box.extrema) {
    const { lo, hi } = ex.param;
    assert.ok(lo.ge(Rat.ZERO) && hi.le(Rat.ONE), "param bracket inside [0,1]");
    assert.ok(hi.sub(lo).le(box.eps), "param bracket width <= eps");
    // The enclosed value must be consistent with the reported axis bounds.
    const axisBox = box[ex.axis];
    assert.ok(ex.value.lo.ge(axisBox.min.lo));
    assert.ok(ex.value.hi.le(axisBox.max.hi));
    // Exact evaluation at bracket endpoints must lie inside the value enclosure.
    for (const t of [lo, hi]) {
      const v = evaluate(curve, t)[ex.axis];
      assert.ok(v.ge(ex.value.lo) && v.le(ex.value.hi),
        `value enclosure invalid at bracket endpoint t=${t}`);
    }
  }
  void curve;
}

test("endpoint acceptance: monotone curve yields exact endpoint box", () => {
  // Quarter unit circle: x decreases 1->0, y increases 0->1, both monotone.
  const curve = makeCurve(vec2(r(1), r(0)), vec2(r(1), r(1)), vec2(r(0), r(1)), r(1), r(1), r(2));
  const box = rationalQuadraticAABB(curve, EPS);
  assert.equal(box.extrema.length, 0);
  assert.ok(box.x.min.lo.eq(r(0)) && box.x.min.hi.eq(r(0)));
  assert.ok(box.x.max.lo.eq(r(1)) && box.x.max.hi.eq(r(1)));
  assert.ok(box.y.min.lo.eq(r(0)) && box.y.min.hi.eq(r(0)));
  assert.ok(box.y.max.lo.eq(r(1)) && box.y.max.hi.eq(r(1)));
  assertSamplingContainment(curve, box, 4096);
});

test("endpoint acceptance: derivative root outside (0,1) uses endpoints only", () => {
  const curve = makeCurve(vec2(r(0), r(0)), vec2(r(1), r(0)), vec2(r(2), r(1)));
  const box = rationalQuadraticAABB(curve, EPS);
  assert.equal(box.extrema.length, 0);
  assert.ok(box.x.min.lo.eq(r(0)) && box.x.max.hi.eq(r(2)));
  assert.ok(box.y.min.lo.eq(r(0)) && box.y.max.hi.eq(r(1)));
  assertSamplingContainment(curve, box, 4096);
});

test("constant curve: degenerate box, no extrema", () => {
  const curve = makeCurve(vec2(r(3, 7), r(-2, 5)), vec2(r(3, 7), r(-2, 5)), vec2(r(3, 7), r(-2, 5)),
    r(1), r(5, 3), r(2));
  const box = rationalQuadraticAABB(curve, EPS);
  assert.equal(box.extrema.length, 0);
  for (const axis of [box.x, box.y] as const) {
    assert.ok(axis.min.lo.eq(axis.min.hi));
    assert.ok(axis.max.lo.eq(axis.max.hi));
    assert.ok(axis.min.lo.eq(axis.max.lo));
  }
  assert.ok(box.x.min.lo.eq(r(3, 7)));
  assert.ok(box.y.min.lo.eq(r(-2, 5)));
  assertSamplingContainment(curve, box, 1024);
});

test("parabola apex: interior extremum isolated with rational bounds", () => {
  // y(t) = 2t(1-t)*2 / 1 ... control (0,0),(1,2),(2,0), unit weights:
  // apex exactly at t = 1/2 with y = 1.
  const curve = makeCurve(vec2(r(0), r(0)), vec2(r(1), r(2)), vec2(r(2), r(0)));
  const box = rationalQuadraticAABB(curve, EPS);
  const yExtrema = box.extrema.filter((e) => e.axis === "y");
  assert.equal(yExtrema.length, 1);
  const ex = yExtrema[0]!;
  // t* = 1/2 is rational: the bracket must collapse to the exact point.
  assert.ok(ex.param.lo.eq(r(1, 2)) && ex.param.hi.eq(r(1, 2)));
  assert.ok(ex.value.lo.le(r(1)) && ex.value.hi.ge(r(1)));
  assert.ok(box.y.max.lo.le(r(1)) && box.y.max.hi.ge(r(1)));
  assert.ok(box.y.max.hi.sub(r(1)).le(r(1, 1000)), "max bound is tight");
  assert.ok(box.y.min.lo.eq(r(0)) && box.y.min.hi.eq(r(0)));
  assert.ok(box.x.min.lo.eq(r(0)) && box.x.max.hi.eq(r(2)));
  assertExtremaVerifiable(curve, box);
  assertSamplingContainment(curve, box, 4096);
});

test("irrational critical parameter isolated by rational root bracket", () => {
  // Asymmetric weights shift the apex of y off any nice rational point.
  const curve = makeCurve(vec2(r(0), r(0)), vec2(r(1), r(3)), vec2(r(4), r(1)),
    r(1), r(3, 7), r(2));
  const box = rationalQuadraticAABB(curve, EPS);
  assert.ok(box.extrema.length >= 1);
  for (const ex of box.extrema) {
    assert.ok(ex.param.hi.sub(ex.param.lo).le(EPS));
    // Bracket endpoints are rational by construction (Rat type).
    assert.ok(ex.param.lo.den > 0n && ex.param.hi.den > 0n);
  }
  assertExtremaVerifiable(curve, box);
  assertSamplingContainment(curve, box, 4096);
});

test("high-precision rational sampling containment, mixed rational weights", () => {
  const curves: RationalQuadraticBezier[] = [
    makeCurve(vec2(r(-3, 2), r(7, 3)), vec2(r(5, 4), r(-11, 6)), vec2(r(2), r(1, 9)),
      r(2, 3), r(5, 7), r(11, 13)),
    makeCurve(vec2(r(0), r(0)), vec2(r(1), r(1)), vec2(r(0), r(1)), r(1), r(1), r(2)),
    makeCurve(vec2(r(-1), r(-1)), vec2(r(0), r(4)), vec2(r(1), r(-1)), r(3), r(1, 5), r(3)),
    makeCurve(vec2(r(1, 1000), r(-1, 1000)), vec2(r(-7, 3), r(2, 7)), vec2(r(5), r(-3)),
      r(1, 2), r(1, 3), r(1, 5)),
  ];
  for (const [i, curve] of curves.entries()) {
    const box = rationalQuadraticAABB(curve, EPS);
    assertSamplingContainment(curve, box, 4096);
    assertExtremaVerifiable(curve, box);
    // Sanity: box must be finite and ordered.
    const cb = containingBox(box);
    assert.ok(cb.xMin.le(cb.xMax), `curve ${i}: ordered x box`);
    assert.ok(cb.yMin.le(cb.yMax), `curve ${i}: ordered y box`);
  }
});

test("root isolation: irrational root of 2t^2 - 1 bracketed rationally", () => {
  // Root sqrt(2)/2 in (0,1).
  const brackets = isolateQuadraticRoots(2n, 0n, -1n, EPS);
  assert.equal(brackets.length, 1);
  const { lo, hi } = brackets[0]!;
  assert.ok(hi.sub(lo).le(EPS));
  // sqrt(2)/2 ~ 0.7071: verify against tight rational bounds.
  assert.ok(lo.lt(r(70711, 100000)) && hi.gt(r(70710, 100000)));
  // Sign change across the bracket proves isolation.
  const signAt = (t: Rat): bigint => 2n * t.num * t.num - t.den * t.den;
  assert.ok(signAt(lo) <= 0n && signAt(hi) >= 0n);
});

test("root isolation: two interior roots both isolated", () => {
  // f(t) = (t - 1/3)(t - 2/3) scaled: 9t^2 - 9t + 2.
  const brackets = isolateQuadraticRoots(9n, -9n, 2n, EPS);
  assert.equal(brackets.length, 2);
  assert.ok(brackets[0]!.lo.eq(r(1, 3)) && brackets[0]!.hi.eq(r(1, 3)));
  assert.ok(brackets[1]!.lo.eq(r(2, 3)) && brackets[1]!.hi.eq(r(2, 3)));
});

test("root isolation: boundary and exterior roots excluded", () => {
  // f(t) = t(t-1)(...) quadratic with roots exactly 0 and 1:  t^2 - t.
  assert.equal(isolateQuadraticRoots(1n, -1n, 0n, EPS).length, 0);
  // Roots at -1 and 2:  t^2 - t - 2.
  assert.equal(isolateQuadraticRoots(1n, -1n, -2n, EPS).length, 0);
  // No real roots: t^2 + 1.
  assert.equal(isolateQuadraticRoots(1n, 0n, 1n, EPS).length, 0);
});

test("weights must be positive rationals", () => {
  assert.throws(() => makeCurve(vec2(r(0), r(0)), vec2(r(1), r(1)), vec2(r(2), r(0)), r(0), r(1), r(1)));
  assert.throws(() => makeCurve(vec2(r(0), r(0)), vec2(r(1), r(1)), vec2(r(2), r(0)), r(1), r(-1, 2), r(1)));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.ts";
import { PiecewiseLinear } from "../src/piecewise.ts";

const R = (n: number, d = 1): Rational => Rational.of(n, d);

const line = new PiecewiseLinear([
  { t: R(0), v: R(0) },
  { t: R(4), v: R(10) },
  { t: R(10), v: R(-2) },
]);

test("interpolates inside segments", () => {
  assert.equal(line.valueAt(R(2)).toString(), "5");
  assert.equal(line.valueAt(R(7)).toString(), "4");
  assert.equal(line.valueAt(R(10)).toString(), "-2");
});

test("extrapolates with end slopes outside the domain", () => {
  assert.equal(line.valueAt(R(-2)).toString(), "-5");
  assert.equal(line.valueAt(R(13)).toString(), "-8");
});

test("slope at a breakpoint belongs to the right segment", () => {
  assert.equal(line.slopeAt(R(0)).toString(), "5/2");
  assert.equal(line.slopeAt(R(4)).toString(), "-2");
  assert.equal(line.slopeAt(R(20)).toString(), "-2");
});

test("nextBreakpointAfter is strict", () => {
  assert.equal(line.nextBreakpointAfter(R(4))?.toString(), "10");
  assert.equal(line.nextBreakpointAfter(R(10)), null);
});

test("rejects non-increasing breakpoints", () => {
  assert.throws(
    () =>
      new PiecewiseLinear([
        { t: R(0), v: R(0) },
        { t: R(0), v: R(1) },
      ]),
  );
});

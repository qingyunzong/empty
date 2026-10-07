import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Fraction,
  aabbContains,
  derivativeNumerator,
  evaluateRationalQuadratic,
  isolateRoots,
  ivWidth,
  polyEval,
  rationalQuadraticAABB,
  type RationalQuadraticAABB,
} from "../src/index.js";

function assertFractionEq(actual: Fraction, expected: Fraction | number | string) {
  const e = Fraction.of(expected);
  assert.ok(
    actual.equals(e),
    `expected ${actual.toString()} to equal ${e.toString()}`,
  );
}

test("Fraction: exact arithmetic and parsing", () => {
  assertFractionEq(Fraction.of("3/4").add(Fraction.of(0.5)), "5/4");
  assertFractionEq(Fraction.of(2).div(Fraction.of("4/6")), 3);
  assertFractionEq(Fraction.of("1.5e-1"), "3/20");
  assert.equal(Fraction.of("-2/4").toString(), "-1/2");
  assert.ok(Fraction.of("1/3").cmp(Fraction.of("2/7")) > 0);
});

test("parabola (unit weights): exact rational interior extremum", () => {
  // y = 4t(1-t), max y = 1 at t = 1/2; x monotone on [0, 2].
  const box = rationalQuadraticAABB({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 0 }, [1, 1, 1]);
  assertFractionEq(box.x.lo, 0);
  assertFractionEq(box.x.hi, 2);
  assertFractionEq(box.y.lo, 0);
  assertFractionEq(box.y.hi, 1);
  const interior = box.extrema.filter((e) => e.kind === "interior");
  assert.equal(interior.length, 1);
  assert.equal(interior[0].axis, "y");
  assertFractionEq(interior[0].t.lo, "1/2");
  assertFractionEq(interior[0].t.hi, "1/2");
  assertFractionEq(interior[0].value.hi, 1);
});

test("monotone curve: endpoint acceptance only", () => {
  // x = 2t + t^2 and y = t/2 + t^2/2 are strictly increasing on [0, 1].
  const box = rationalQuadraticAABB({ x: 0, y: 0 }, { x: 1, y: "1/4" }, { x: 3, y: 1 }, [1, 1, 1]);
  assertFractionEq(box.x.lo, 0);
  assertFractionEq(box.x.hi, 3);
  assertFractionEq(box.y.lo, 0);
  assertFractionEq(box.y.hi, 1);
  for (const e of box.extrema) assert.equal(e.kind, "endpoint");
  const tValues = box.extrema.map((e) => e.t.lo.toString()).sort();
  assert.deepEqual(tValues, ["0", "0", "1", "1"]);
});

test("constant curve: degenerate point box", () => {
  const p = { x: "3/2", y: -2 };
  const box = rationalQuadraticAABB(p, p, p, [2, 3, 4]);
  assertFractionEq(box.x.lo, "3/2");
  assertFractionEq(box.x.hi, "3/2");
  assertFractionEq(box.y.lo, -2);
  assertFractionEq(box.y.hi, -2);
  for (const t of ["0", "1/3", "7/11", "1"]) {
    const q = evaluateRationalQuadratic(p, p, p, [2, 3, 4], t);
    assertFractionEq(q.x, "3/2");
    assertFractionEq(q.y, -2);
  }
});

test("rejects non-positive weights", () => {
  const p = { x: 0, y: 0 };
  assert.throws(() => rationalQuadraticAABB(p, p, p, [1, 0, 1]), /positive/);
  assert.throws(() => rationalQuadraticAABB(p, p, p, [1, "-1/2", 1]), /positive/);
  assert.throws(() => evaluateRationalQuadratic(p, p, p, [0, 1, 1], "1/2"), /positive/);
});

test("irrational extremum: certified verifiable parameter interval", () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 1, y: 1 };
  const p2 = { x: 2, y: 0 };
  const w: [number, number, number] = [1, 2, 3];
  const box = rationalQuadraticAABB(p0, p1, p2, w);
  const interior = box.extrema.filter((e) => e.kind === "interior");
  assert.equal(interior.length, 1);
  const e = interior[0];
  assert.equal(e.axis, "y");
  // True maximizer is t* = (sqrt(3) - 1) / 2, irrational: the interval must
  // have distinct rational endpoints bracketing it.
  assert.ok(e.t.lo.cmp(e.t.hi) < 0);
  assert.ok(e.t.lo.cmp(Fraction.ZERO) >= 0 && e.t.hi.cmp(Fraction.ONE) <= 0);
  // IVT certificate: the derivative numerator changes sign over [lo, hi].
  const m = derivativeNumerator(p0, p1, p2, w, "y");
  const sLo = polyEval(m, e.t.lo).sign();
  const sHi = polyEval(m, e.t.hi).sign();
  assert.ok(sLo * sHi <= 0, `no sign change: ${sLo}, ${sHi}`);
  // Isolation width is below the requested precision (default 256 bits).
  assert.ok(ivWidth(e.t).cmp(Fraction.fromParts(1n, 1n << 128n)) < 0);
  // Exact algebraic certificate: the true maximum is y(t*) = 4 - 2*sqrt(3).
  // lo <= 4 - 2*sqrt(3) <= hi  <=>  (4-lo)^2 >= 12 >= (4-hi)^2  (both sides > 0).
  const four = Fraction.of(4);
  const twelve = Fraction.of(12);
  const a = four.sub(e.value.lo);
  const b = four.sub(e.value.hi);
  assert.ok(b.sign() > 0);
  assert.ok(a.mul(a).cmp(twelve) >= 0 && b.mul(b).cmp(twelve) <= 0);
});

test("root isolation brackets sqrt(2)", () => {
  const roots = isolateRoots([Fraction.of(-2), Fraction.ZERO, Fraction.ONE], 128);
  assert.equal(roots.length, 2);
  const two = Fraction.of(2);
  const pos = roots[1];
  assert.ok(pos.lo.mul(pos.lo).cmp(two) <= 0);
  assert.ok(pos.hi.mul(pos.hi).cmp(two) >= 0);
  const neg = roots[0];
  assert.ok(neg.lo.mul(neg.lo).cmp(two) >= 0);
  assert.ok(neg.hi.mul(neg.hi).cmp(two) <= 0);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random curves: high-precision rational sampling containment and tightness", () => {
  const rnd = mulberry32(0x5eed);
  const randRat = (maxNum: number, signed: boolean): Fraction => {
    const num = Math.floor(rnd() * maxNum);
    const den = 1 + Math.floor(rnd() * 9);
    const n = signed && rnd() < 0.5 ? -num : num;
    return Fraction.fromParts(BigInt(n), BigInt(den));
  };
  const tolerance = Fraction.of("1/1000000");

  for (let curve = 0; curve < 25; curve++) {
    const p0 = { x: randRat(50, true), y: randRat(50, true) };
    const p1 = { x: randRat(50, true), y: randRat(50, true) };
    const p2 = { x: randRat(50, true), y: randRat(50, true) };
    const w: [Fraction, Fraction, Fraction] = [
      randRat(20, false).add(Fraction.ONE),
      randRat(20, false).add(Fraction.ONE),
      randRat(20, false).add(Fraction.ONE),
    ];
    const box: RationalQuadraticAABB = rationalQuadraticAABB(p0, p1, p2, w);
    assert.ok(box.x.lo.cmp(box.x.hi) <= 0 && box.y.lo.cmp(box.y.hi) <= 0);

    // High-precision rational samples: coarse grid plus 40-bit dyadics.
    const samples: Fraction[] = [];
    for (let k = 0; k <= 64; k++) samples.push(Fraction.fromParts(BigInt(k), 64n));
    for (let k = 0; k < 40; k++) {
      const num = BigInt(Math.floor(rnd() * 2 ** 40));
      samples.push(Fraction.fromParts(num, 1n << 40n));
    }
    // Sample exactly at the certified extremum interval endpoints too.
    for (const e of box.extrema) {
      if (e.kind === "interior") {
        samples.push(e.t.lo, e.t.hi);
        // IVT certificate for every interior extremum.
        const m = derivativeNumerator(p0, p1, p2, w, e.axis);
        const sLo = polyEval(m, e.t.lo).sign();
        const sHi = polyEval(m, e.t.hi).sign();
        assert.ok(sLo * sHi <= 0, `curve ${curve}: no sign change on ${e.axis}`);
      }
    }

    let minX: Fraction | null = null;
    let maxX: Fraction | null = null;
    let minY: Fraction | null = null;
    let maxY: Fraction | null = null;
    for (const t of samples) {
      const q = evaluateRationalQuadratic(p0, p1, p2, w, t);
      assert.ok(
        aabbContains(box, q.x, q.y),
        `curve ${curve}: sample (${q.x}, ${q.y}) outside box ` +
          `[${box.x.lo}, ${box.x.hi}] x [${box.y.lo}, ${box.y.hi}]`,
      );
      minX = minX === null ? q.x : Fraction.min(minX, q.x);
      maxX = maxX === null ? q.x : Fraction.max(maxX, q.x);
      minY = minY === null ? q.y : Fraction.min(minY, q.y);
      maxY = maxY === null ? q.y : Fraction.max(maxY, q.y);
    }
    // Tightness: the certified box overshoot versus the sampled range is tiny.
    for (const [lo, hi, sMin, sMax] of [
      [box.x.lo, box.x.hi, minX!, maxX!],
      [box.y.lo, box.y.hi, minY!, maxY!],
    ] as const) {
      const gap = hi.sub(lo).sub(sMax.sub(sMin));
      assert.ok(gap.sign() >= 0, `curve ${curve}: box does not contain samples`);
      assert.ok(gap.cmp(tolerance) < 0, `curve ${curve}: box too loose, gap ${gap}`);
    }
  }
});

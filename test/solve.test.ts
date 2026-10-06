import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fraction } from "../src/fraction";
import { Line, XY, lineThrough } from "../src/bezier";
import { runCli } from "../src/cli";
import { mobius, signVariations, squareFree } from "../src/poly";
import { solveCurveLine } from "../src/solve";

const F = (n: number, d = 1): Fraction => Fraction.of(n, d);
const pt = (x: number, y: number, xd = 1, yd = 1): XY => ({
  x: F(x, xd),
  y: F(y, yd),
});

const lineX: Line = lineThrough(pt(0, 0), pt(1, 0));

function binom(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);
  return r;
}

/** Power-basis coeffs (ascending) -> cubic Bernstein control values. */
function bernsteinFromPower(a: Fraction[]): Fraction[] {
  const n = a.length - 1;
  const b: Fraction[] = [];
  for (let i = 0; i <= n; i++) {
    let s = Fraction.ZERO;
    for (let j = 0; j <= i; j++) {
      s = s.add(a[j].mul(Fraction.of(binom(i, j), binom(n, j))));
    }
    b.push(s);
  }
  return b;
}

type Coeff = number | [number, number];

/** Segment with x(u) = u and y(u) given by power-basis coefficients. */
function segmentFromYPower(coeffs: Coeff[]): XY[] {
  const a = coeffs.map((c) =>
    typeof c === "number" ? F(c) : F(c[0], c[1]),
  );
  while (a.length < 4) a.push(Fraction.ZERO);
  const by = bernsteinFromPower(a);
  const bx = bernsteinFromPower([
    Fraction.ZERO,
    Fraction.ONE,
    Fraction.ZERO,
    Fraction.ZERO,
  ]);
  return bx.map((x, i) => ({ x, y: by[i] }));
}

function contains(lo: Fraction, hi: Fraction, x: Fraction): boolean {
  return lo.cmp(x) <= 0 && x.cmp(hi) <= 0;
}

// y(u) = (u - 1/4)(u - 1/2)(u - 3/4) = u^3 - 3/2 u^2 + 11/16 u - 3/32
const THREE_ROOTS: Coeff[] = [[-3, 32], [11, 16], [-3, 2], 1];

test("three simple roots at 1/4, 1/2, 3/4 with multiplicity 1", () => {
  const res = solveCurveLine(lineX, [segmentFromYPower(THREE_ROOTS)]);
  assert.equal(res.onLine.length, 0);
  assert.equal(res.unknown.length, 0);
  assert.equal(res.roots.length, 3);
  const expected = [F(1, 4), F(1, 2), F(3, 4)];
  res.roots.forEach((r, i) => {
    assert.equal(r.segment, 0);
    assert.equal(r.multiplicity, 1);
    assert.ok(
      contains(r.tLo, r.tHi, expected[i]),
      `root ${i} interval [${r.tLo}, ${r.tHi}] must contain ${expected[i]}`,
    );
    assert.ok(r.tHi.sub(r.tLo).cmp(F(1, 1024)) < 0, "interval is tight");
  });
  // The middle root is exactly dyadic and must be found exactly.
  assert.ok(res.roots[1].exact);
  assert.ok(res.roots[1].tLo.equals(F(1, 2)));
});

test("double root at 1/2 has multiplicity 2", () => {
  // y(u) = (u - 1/2)^2 (u + 1) = u^3 - 3/4 u + 1/4
  const res = solveCurveLine(
    lineX,
    [segmentFromYPower([[1, 4], [-3, 4], 0, 1])],
  );
  assert.equal(res.unknown.length, 0);
  assert.equal(res.roots.length, 1);
  assert.equal(res.roots[0].multiplicity, 2);
  assert.ok(contains(res.roots[0].tLo, res.roots[0].tHi, F(1, 2)));
});

test("triple root at 1/2 has multiplicity 3", () => {
  // y(u) = (u - 1/2)^3 = u^3 - 3/2 u^2 + 3/4 u - 1/8
  const res = solveCurveLine(
    lineX,
    [segmentFromYPower([[-1, 8], [3, 4], [-3, 2], 1])],
  );
  assert.equal(res.roots.length, 1);
  assert.equal(res.roots[0].multiplicity, 3);
  assert.ok(contains(res.roots[0].tLo, res.roots[0].tHi, F(1, 2)));
});

test("roots exactly at segment endpoints u=0 and u=1", () => {
  // y(u) = u(u - 1)(u - 2) = u^3 - 3u^2 + 2u
  const res = solveCurveLine(lineX, [segmentFromYPower([0, 2, -3, 1])]);
  assert.equal(res.unknown.length, 0);
  assert.equal(res.roots.length, 2);
  assert.ok(res.roots[0].exact && res.roots[0].tLo.equals(F(0)));
  assert.ok(res.roots[1].exact && res.roots[1].tLo.equals(F(1)));
  assert.ok(res.roots.every((r) => r.multiplicity === 1));
});

test("exact dyadic root of a linear segment", () => {
  // y(u) = u - 1/2
  const res = solveCurveLine(lineX, [segmentFromYPower([[-1, 2], 1])]);
  assert.equal(res.roots.length, 1);
  assert.ok(res.roots[0].exact);
  assert.ok(res.roots[0].tLo.equals(F(1, 2)));
  assert.equal(res.roots[0].multiplicity, 1);
});

test("segment lying on the line reports the whole interval", () => {
  const diag = lineThrough(pt(0, 0), pt(1, 1));
  const seg = [pt(0, 0), pt(1, 1, 3, 3), pt(2, 2, 3, 3), pt(1, 1)];
  const res = solveCurveLine(diag, [seg]);
  assert.equal(res.roots.length, 0);
  assert.equal(res.unknown.length, 0);
  assert.equal(res.onLine.length, 1);
  assert.equal(res.onLine[0].segment, 0);
  assert.ok(res.onLine[0].tLo.equals(F(0)));
  assert.ok(res.onLine[0].tHi.equals(F(1)));
});

test("multi-segment curve: global parameter t = segment + u", () => {
  const onLineSeg = [pt(0, 0), pt(1, 0, 3, 1), pt(2, 0, 3, 1), pt(1, 0)];
  const res = solveCurveLine(lineX, [onLineSeg, segmentFromYPower(THREE_ROOTS)]);
  assert.equal(res.onLine.length, 1);
  assert.ok(res.onLine[0].tLo.equals(F(0)));
  assert.ok(res.onLine[0].tHi.equals(F(1)));
  assert.equal(res.roots.length, 3);
  const expected = [F(5, 4), F(3, 2), F(7, 4)];
  res.roots.forEach((r, i) => {
    assert.equal(r.segment, 1);
    assert.ok(contains(r.tLo, r.tHi, expected[i]));
  });
});

test("no intersection yields empty results", () => {
  const res = solveCurveLine(lineX, [segmentFromYPower([1])]);
  assert.equal(res.roots.length, 0);
  assert.equal(res.onLine.length, 0);
  assert.equal(res.unknown.length, 0);
});

test("exhausted budget marks unresolved intervals as unknown", () => {
  const seg = segmentFromYPower(THREE_ROOTS);
  // Zero budget: the whole parameter range stays unresolved.
  const none = solveCurveLine(lineX, [seg], { budget: 0 });
  assert.equal(none.roots.length, 0);
  assert.equal(none.unknown.length, 1);
  assert.equal(none.unknown[0].reason, "budget-exceeded");
  assert.ok(none.unknown[0].tLo.equals(F(0)));
  assert.ok(none.unknown[0].tHi.equals(F(1)));
  // A tiny budget may still discover the exact dyadic root at u = 1/2,
  // but the remaining intervals must be reported as unknown.
  const little = solveCurveLine(lineX, [seg], { budget: 1 });
  assert.ok(little.unknown.length >= 1);
  assert.ok(little.unknown.every((u) => u.reason === "budget-exceeded"));
  // With a sufficient budget the same curve resolves completely.
  const ok = solveCurveLine(lineX, [seg], { budget: 10_000 });
  assert.equal(ok.unknown.length, 0);
  assert.equal(ok.roots.length, 3);
  assert.ok(ok.stats.nodesUsed > 0);
});

test("segment count is limited to 1..8", () => {
  const seg = segmentFromYPower([1]);
  assert.equal(solveCurveLine(lineX, Array(8).fill(seg)).roots.length, 0);
  assert.throws(() => solveCurveLine(lineX, Array(9).fill(seg)), /1\.\.8/);
  assert.throws(() => solveCurveLine(lineX, []), /1\.\.8/);
});

test("degenerate line is rejected", () => {
  assert.throws(() => lineThrough(pt(1, 1), pt(1, 1)), /degenerate/);
});

test("non-axis line y = 1/2 keeps the same known roots", () => {
  const line = lineThrough(pt(0, 1, 1, 2), pt(1, 1, 1, 2));
  // y(u) = (u - 1/4)(u - 1/2)(u - 3/4) + 1/2
  const shifted: Coeff[] = [[13, 32], [11, 16], [-3, 2], 1];
  const res = solveCurveLine(line, [segmentFromYPower(shifted)]);
  assert.equal(res.roots.length, 3);
  const expected = [F(1, 4), F(1, 2), F(3, 4)];
  res.roots.forEach((r, i) => {
    assert.ok(contains(r.tLo, r.tHi, expected[i]));
  });
});

test("square-free factorization recovers multiplicities", () => {
  // f = (x - 1/2)^2 (x + 1) = x^3 - 3/4 x + 1/4
  const factors = squareFree([F(1, 4), F(-3, 4), F(0), F(1)]);
  assert.equal(factors.length, 2);
  const byMult = new Map(factors.map((f) => [f.multiplicity, f.factor]));
  assert.equal(byMult.get(1)!.length, 2); // x + 1
  assert.equal(byMult.get(2)!.length, 2); // x - 1/2
  assert.ok(byMult.get(2)![0].equals(F(-1, 2)));
});

test("Descartes sign variations count roots in (0,1) exactly", () => {
  const f = [F(-3, 32), F(11, 16), F(-3, 2), F(1)];
  assert.equal(signVariations(mobius(f, F(0), F(1))), 3);
  assert.equal(signVariations(mobius(f, F(0), F(1, 3))), 1);
  assert.equal(signVariations(mobius(f, F(3, 4), F(1))), 0);
});

test("CLI end-to-end on a known-root input", () => {
  const dir = mkdtempSync(join(tmpdir(), "curve-roots-"));
  const file = join(dir, "input.json");
  writeFileSync(
    file,
    JSON.stringify({
      line: { p0: ["0", "0"], p1: ["1", "0"] },
      segments: [
        {
          points: [
            ["0", "-3/32"],
            ["1/3", "13/96"],
            ["2/3", "-13/96"],
            ["1", "3/32"],
          ],
        },
      ],
    }),
  );
  const out = runCli([file]);
  const result = JSON.parse(out);
  assert.equal(result.roots.length, 3);
  assert.equal(result.unknown.length, 0);
  assert.deepEqual(
    result.roots.map((r: { multiplicity: number }) => r.multiplicity),
    [1, 1, 1],
  );
  assert.equal(result.roots[1].exact, true);
  assert.equal(result.roots[1].t.lo, "1/2");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTime } from "../src/mapping.js";
import { Rational, add, eq, mul, rat, cmp, ZERO } from "../src/rational.js";
import { mulberry32, randomRational } from "./helpers.js";

const D = rat(2); // duration used for the boundary tables

const expectLocal = (t: Rational, mode: "once" | "loop" | "pingpong", want: Rational) => {
  const m = mapTime(t, D, mode);
  assert.ok(eq(m.local, want), `${mode} map ${t.n}/${t.d} -> ${want.n}/${want.d}, got ${m.local.n}/${m.local.d}`);
  return m;
};

test("loop boundaries: multiples of D map to 0, defined for negative t", () => {
  expectLocal(rat(0), "loop", rat(0));
  expectLocal(rat(1), "loop", rat(1));
  expectLocal(rat(2), "loop", rat(0)); // end key is only a left-limit
  expectLocal(rat(5), "loop", rat(1));
  expectLocal(rat(7, 2), "loop", rat(3, 2));
  expectLocal(rat(-1), "loop", rat(1));
  expectLocal(rat(-2), "loop", rat(0));
  expectLocal(rat(-7, 2), "loop", rat(1, 2));
  assert.equal(mapTime(rat(5), D, "loop").cycle, 2n);
  assert.equal(mapTime(rat(-1), D, "loop").cycle, -1n);
});

test("pingpong boundaries: peak and trough each hit once per period", () => {
  expectLocal(rat(0), "pingpong", rat(0));
  expectLocal(rat(1), "pingpong", rat(1));
  expectLocal(rat(2), "pingpong", rat(2)); // peak attained
  expectLocal(rat(3), "pingpong", rat(1));
  expectLocal(rat(4), "pingpong", rat(0)); // trough attained
  expectLocal(rat(5), "pingpong", rat(1));
  expectLocal(rat(-1), "pingpong", rat(1));
  expectLocal(rat(-2), "pingpong", rat(2));
  expectLocal(rat(-4), "pingpong", rat(0));
  assert.equal(mapTime(rat(1), D, "pingpong").direction, 1);
  assert.equal(mapTime(rat(3), D, "pingpong").direction, -1);
  assert.equal(mapTime(rat(2), D, "pingpong").direction, -1); // [D, 2D) is the return leg
  assert.equal(mapTime(rat(4), D, "pingpong").direction, 1);
});

test("once clamps to [0, D]", () => {
  expectLocal(rat(-3), "once", rat(0));
  expectLocal(rat(99), "once", rat(2));
  expectLocal(rat(3, 2), "once", rat(3, 2));
  assert.equal(mapTime(rat(-3), D, "once").direction, 0);
});

test("random times: loop/pingpong periodicity and pingpong symmetry", () => {
  const rnd = mulberry32(7);
  const period = rat(4); // 2D
  for (let i = 0; i < 1000; i++) {
    const t = randomRational(rnd, 10_000, 24);
    const k = BigInt(Math.floor(rnd() * 2000) - 1000);
    const shifted = add(t, mul(period, rat(k)));
    const loopShifted = add(t, mul(D, rat(k)));

    const loopA = mapTime(t, D, "loop").local;
    const loopB = mapTime(loopShifted, D, "loop").local;
    assert.ok(eq(loopA, loopB), "loop periodic");
    assert.ok(cmp(loopA, ZERO) >= 0 && cmp(loopA, D) < 0, "loop range");

    const ppA = mapTime(t, D, "pingpong").local;
    const ppB = mapTime(shifted, D, "pingpong").local;
    assert.ok(eq(ppA, ppB), "pingpong periodic");
    assert.ok(cmp(ppA, ZERO) >= 0 && cmp(ppA, D) <= 0, "pingpong range");

    // Symmetry: local(D + u) == local(D - u)
    const u = randomRational(rnd, 1000, 12);
    assert.ok(
      eq(mapTime(add(D, u), D, "pingpong").local, mapTime(add(D, { n: -u.n, d: u.d }), D, "pingpong").local),
      "pingpong mirror symmetry",
    );
  }
});

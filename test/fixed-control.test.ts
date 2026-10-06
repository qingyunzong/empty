import test from "node:test";
import * as assert from "node:assert/strict";
import { runProperty } from "../src/property";
import { integer, arrayOf } from "../src/gen";
import { smallInts, firstCounterexample, fixedCycle } from "../src/fixed";

test("fixed small generators are deterministic and order-free", () => {
  const gen = smallInts();
  const run = () =>
    runProperty("fixed/determinism", gen, () => true, { seed: 1, runs: 11 });
  assert.ok(run().ok);
  // Enumerate twice, interleaved with other work: identical sequences.
  const seq1 = Array.from({ length: 11 }, (_, i) => gen({} as never, i).value);
  const seq2 = Array.from({ length: 11 }, (_, i) => gen({} as never, i).value);
  assert.deepEqual(seq1, seq2);
  assert.deepEqual(seq1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("control: random shrink converges to the fixed generator's minimal counterexample", () => {
  const check = (n: number) => n < 7;

  // Control group: fixed small generator finds the minimal counterexample
  // by deterministic enumeration.
  const expected = firstCounterexample(smallInts(), check, 11);
  assert.equal(expected, 7);

  // Experimental group: random generation + verified shrinking.
  const result = runProperty("control/int", integer(0, 1000), check, {
    seed: 424242,
    runs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.record!.counterexample,
    expected,
    "shrunk random counterexample must equal the fixed-generator minimum"
  );
});

test("control: array property minimal counterexample matches fixed enumeration", () => {
  const check = (xs: number[]) => !xs.some((x) => x >= 3);

  // Control group: fixed generator enumerates singleton lists [0],[1],...
  const singletons = fixedCycle([[0], [1], [2], [3], [4], [5]]);
  const expected = firstCounterexample(singletons, check, 6);
  assert.deepEqual(expected, [3]);

  // Experimental group: random arrays + verified shrinking.
  const result = runProperty(
    "control/array",
    arrayOf(integer(0, 9), { maxLength: 5 }),
    check,
    { seed: 99, runs: 500 }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.record!.counterexample, expected);
});

test("fixedCycle wraps around deterministically", () => {
  const gen = fixedCycle(["x", "y", "z"]);
  const values = Array.from({ length: 7 }, (_, i) => gen({} as never, i).value);
  assert.deepEqual(values, ["x", "y", "z", "x", "y", "z", "x"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { TxState } from "../src/txstate";
import { ModelState } from "./model";
import { genProgram, mulberry32, runSafely } from "./random";

test("random programs: TxState matches the copy-stack model", () => {
  const seedCount = Number(process.env.SEEDS ?? 500);
  for (let seed = 1; seed <= seedCount; seed++) {
    const rand = mulberry32(seed);
    const ops = genProgram(rand, 60);
    const budget =
      rand() < 0.5
        ? Number.POSITIVE_INFINITY
        : 5 + Math.floor(rand() * 45);
    const actual = runSafely(new TxState({ budget }), ops);
    const expected = runSafely(new ModelState({ budget }), ops);
    assert.deepEqual(actual, expected, `divergence at seed=${seed}`);
  }
});

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Rng, deriveSeed, hashString } from "../src/rng.js";

test("same seed reproduces the exact same stream", () => {
  const a = new Rng(42n);
  const b = new Rng(42n);
  for (let i = 0; i < 100; i++) {
    assert.equal(a.nextU64(), b.nextU64());
  }
});

test("different seeds produce different streams", () => {
  const a = new Rng(1n);
  const b = new Rng(2n);
  const seqA = Array.from({ length: 10 }, () => a.nextU64());
  const seqB = Array.from({ length: 10 }, () => b.nextU64());
  assert.notEqual(seqA.join(","), seqB.join(","));
});

test("state is a single integer and fully determines the future stream", () => {
  const a = new Rng(7n);
  a.nextU64();
  a.nextU64();
  const snapshot = a.getState();
  const resumed = new Rng(snapshot);
  assert.equal(a.nextU64(), resumed.nextU64());
  assert.equal(a.nextU64(), resumed.nextU64());
});

test("nextInt stays within the inclusive range", () => {
  const rng = new Rng(123n);
  for (let i = 0; i < 1000; i++) {
    const v = rng.nextInt(-5, 7);
    assert.ok(v >= -5 && v <= 7, `out of range: ${v}`);
  }
});

test("deriveSeed depends only on inputs, not on call order", () => {
  const first = deriveSeed(99n, "test-a");
  const second = deriveSeed(99n, "test-b");
  const firstAgain = deriveSeed(99n, "test-a");
  assert.equal(first, firstAgain);
  assert.notEqual(first, second);
});

test("hashString is deterministic and order-sensitive", () => {
  assert.equal(hashString("abc"), hashString("abc"));
  assert.notEqual(hashString("abc"), hashString("abd"));
});

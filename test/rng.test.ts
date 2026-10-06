import test from "node:test";
import * as assert from "node:assert/strict";
import { Rng, hashSeed, mixSeed } from "../src/rng";

test("same seed produces the identical stream", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) {
    assert.equal(a.nextUint32(), b.nextUint32());
  }
});

test("different seeds produce different streams", () => {
  const a = new Rng(1);
  const b = new Rng(2);
  const sa = Array.from({ length: 10 }, () => a.nextUint32());
  const sb = Array.from({ length: 10 }, () => b.nextUint32());
  assert.notDeepEqual(sa, sb);
});

test("state is a single integer and fully resumable", () => {
  const a = new Rng(7);
  a.nextUint32();
  a.nextUint32();
  const snapshot = a.getState();
  assert.equal(typeof snapshot, "number");
  assert.ok(Number.isInteger(snapshot));
  const rest = Array.from({ length: 5 }, () => a.nextUint32());
  const resumed = new Rng(snapshot);
  const rest2 = Array.from({ length: 5 }, () => resumed.nextUint32());
  assert.deepEqual(rest, rest2);
});

test("nextInt stays within inclusive bounds", () => {
  const rng = new Rng(123);
  for (let i = 0; i < 1000; i++) {
    const v = rng.nextInt(-3, 3);
    assert.ok(v >= -3 && v <= 3, `out of range: ${v}`);
  }
});

test("hashSeed is name-sensitive and order-free", () => {
  assert.equal(hashSeed(99, "prop-a"), hashSeed(99, "prop-a"));
  assert.notEqual(hashSeed(99, "prop-a"), hashSeed(99, "prop-b"));
  assert.notEqual(hashSeed(1, "x"), hashSeed(2, "x"));
});

test("mixSeed is deterministic", () => {
  assert.equal(mixSeed(5, 6), mixSeed(5, 6));
  assert.notEqual(mixSeed(5, 6), mixSeed(6, 5));
});

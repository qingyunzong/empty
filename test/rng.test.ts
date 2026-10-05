import { test } from "node:test";
import { deepEqual, equal, notEqual } from "node:assert/strict";
import { Rng, seedFromString, seedToString } from "../src/rng";

test("same seed string produces identical streams", () => {
  const a = new Rng(seedFromString("seed-1"));
  const b = new Rng(seedFromString("seed-1"));
  const sa = Array.from({ length: 16 }, () => a.nextU32());
  const sb = Array.from({ length: 16 }, () => b.nextU32());
  deepEqual(sa, sb);
});

test("different seeds produce different streams", () => {
  const a = new Rng(seedFromString("seed-1"));
  const b = new Rng(seedFromString("seed-2"));
  notEqual(a.nextU32(), b.nextU32());
});

test("seeds are JSON-serializable and survive a round trip", () => {
  const seed = seedFromString("hello world");
  const restored = JSON.parse(JSON.stringify(seed));
  deepEqual(restored, seed);
  const a = new Rng(seed).int(0, 1_000_000);
  const b = new Rng(restored).int(0, 1_000_000);
  equal(a, b);
});

test("seedToString renders a plain string usable as a seed", () => {
  const s = seedToString(seedFromString("abc"));
  equal(typeof s, "string");
  const a = new Rng(seedFromString(s)).nextU32();
  const b = new Rng(seedFromString(s)).nextU32();
  equal(a, b);
});

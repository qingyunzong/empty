import { test } from "node:test";
import * as assert from "node:assert/strict";
import { PersistentModeArray } from "../src/mode-array";
import { sortedCountMode } from "../src/model";

/** Deterministic PRNG (mulberry32) so the randomized cross-check is reproducible. */
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

test("mode: highest frequency wins, evidence reports the count", () => {
  const arr = new PersistentModeArray([5, 2, 5, 3, 2, 5]);
  assert.deepEqual(arr.queryMode(0, 0, 6), { value: 5, count: 3 });
  assert.deepEqual(arr.queryMode(0, 0, 4), { value: 5, count: 2 });
  assert.deepEqual(arr.queryMode(0, 1, 4), { value: 2, count: 1 });
});

test("mode: ties break to the smaller value", () => {
  const arr = new PersistentModeArray([9, 4, 9, 4, 1]);
  assert.deepEqual(arr.queryMode(0, 0, 4), { value: 4, count: 2 });
  assert.deepEqual(arr.queryMode(0, 0, 5), { value: 4, count: 2 });
});

test("empty range returns null", () => {
  const arr = new PersistentModeArray([1, 2, 3]);
  assert.equal(arr.queryMode(0, 2, 2), null);
  assert.equal(arr.queryMode(0, 0, 0), null);
});

test("block update is atomic and old versions stay queryable", () => {
  const arr = new PersistentModeArray([1, 1, 2, 2, 3]);
  const v1 = arr.replaceRange(0, 1, 4, 7); // [1,7,7,7,3]
  assert.equal(v1, 1);
  const v2 = arr.replaceRange(v1, 0, 2, 8); // [8,8,7,7,3]

  // New versions reflect the fully applied block update.
  assert.deepEqual(arr.queryMode(v1, 0, 5), { value: 7, count: 3 });
  assert.deepEqual(arr.queryMode(v2, 0, 5), { value: 7, count: 2 });
  // Old version is untouched and still queryable.
  assert.deepEqual(arr.queryMode(0, 0, 5), { value: 1, count: 2 });
  assert.deepEqual([...arr.snapshot(0)], [1, 1, 2, 2, 3]);
});

test("invalid ranges and versions are rejected", () => {
  const arr = new PersistentModeArray([1, 2, 3]);
  assert.throws(() => arr.queryMode(0, -1, 2));
  assert.throws(() => arr.queryMode(0, 2, 1));
  assert.throws(() => arr.queryMode(0, 0, 4));
  assert.throws(() => arr.queryMode(9, 0, 1));
  assert.throws(() => arr.replaceRange(0, 0, 2, 1.5));
});

test("randomized cross-check vs sorted-count model (replacements, old versions, empty ranges)", () => {
  const rand = mulberry32(0xC0FFEE);
  const pick = (n: number) => Math.floor(rand() * n);

  for (let trial = 0; trial < 60; trial++) {
    const n = 1 + pick(24);
    const initial = Array.from({ length: n }, () => pick(7) - 3);
    const arr = new PersistentModeArray(initial);
    const mirrors: number[][] = [initial.slice()];

    const ops = 1 + pick(12);
    for (let op = 0; op < ops; op++) {
      const baseVersion = pick(arr.versionCount);
      const start = pick(n + 1);
      const end = start + pick(n + 1 - start); // may be empty
      const value = pick(7) - 3;
      const newVersion = arr.replaceRange(baseVersion, start, end, value);
      const mirror = mirrors[baseVersion]!.slice();
      mirror.fill(value, start, end);
      mirrors[newVersion] = mirror;
    }

    const queries = 1 + pick(10);
    for (let q = 0; q < queries; q++) {
      const version = pick(arr.versionCount);
      const start = pick(n + 1);
      const end = start + pick(n + 1 - start); // may be empty
      const actual = arr.queryMode(version, start, end);
      const expected = sortedCountMode(mirrors[version]!.slice(start, end));
      assert.deepEqual(
        actual,
        expected,
        `trial=${trial} version=${version} range=[${start},${end})`,
      );
      if (expected !== null) {
        // Frequency evidence must match a direct recount on the mirror.
        const recount = mirrors[version]!
          .slice(start, end)
          .filter((x) => x === expected.value).length;
        assert.equal(actual!.count, recount);
      }
    }
  }
});

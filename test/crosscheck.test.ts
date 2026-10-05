import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePattern, formatPattern, type Segment } from "../src/pattern.js";
import { crossCheck, exhaustiveWitness, domainAlphabet } from "../src/verify.js";
import { searchIntersection } from "../src/search.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPattern(rand: () => number): Segment[] {
  const count = 1 + Math.floor(rand() * 4);
  const segments: Segment[] = [];
  for (let k = 0; k < count; k++) {
    const roll = rand();
    if (roll < 0.4) segments.push({ kind: "lit", value: rand() < 0.5 ? "a" : "b" });
    else if (roll < 0.7) segments.push({ kind: "star" });
    else segments.push({ kind: "dstar" });
  }
  return segments;
}

test("randomized cross-check: symbolic search vs short-domain exhaustion", () => {
  const rand = mulberry32(20261005);
  const iterations = 300;
  for (let n = 0; n < iterations; n++) {
    const allowA = randomPattern(rand);
    const allowB = randomPattern(rand);
    const excludeCount = Math.floor(rand() * 4);
    const excludes = Array.from({ length: excludeCount }, () => randomPattern(rand));
    const check = crossCheck(allowA, allowB, excludes, 4);
    assert.ok(
      check.consistent,
      `inconsistent: ${formatPattern(allowA)} vs ${formatPattern(allowB)} ` +
        `excludes [${excludes.map(formatPattern).join(", ")}]: ${check.note} ` +
        `(search=${JSON.stringify(check.search)}, domain=${JSON.stringify(check.domain.witness)})`,
    );
  }
});

test("short-domain exhaustion accepts the shortest witness", () => {
  const allowA = parsePattern("a/**");
  const allowB = parsePattern("**/b");
  const excludes = [parsePattern("a/b")];
  const check = crossCheck(allowA, allowB, excludes, 5);
  assert.ok(check.consistent, check.note);
  assert.equal(check.search.status, "common");
  if (check.search.status === "common") {
    assert.deepEqual(check.search.witness, ["a", "a", "b"]);
  }
});

test("short-domain exhaustion confirms disjointness", () => {
  const check = crossCheck(parsePattern("a/*"), parsePattern("b/*"), [], 3);
  assert.ok(check.consistent, check.note);
  assert.equal(check.search.status, "disjoint");
  assert.equal(check.domain.witness, null);
});

test("witness longer than the domain is reported consistently", () => {
  // Every path of length 0..4 is excluded, so the shortest witness has 5
  // segments and the domain of depth 4 must come back empty.
  const excludes = ["*", "*/*", "*/*/*", "*/*/*/*"].map(parsePattern);
  const check = crossCheck(parsePattern("*/**"), parsePattern("**"), excludes, 4);
  assert.ok(check.consistent, check.note);
  assert.equal(check.search.status, "common");
  if (check.search.status === "common") {
    assert.equal(check.search.witness.length, 5);
    assert.deepEqual(check.search.witness, ["a", "a", "a", "a", "a"]);
  }
});

test("exhaustiveWitness enumerates in (length, byte) order", () => {
  const star = parsePattern("*");
  const witness = exhaustiveWitness(star, star, [], ["b", "a"], 2);
  assert.deepEqual(witness, ["a"]);
  const alphabet = domainAlphabet([parsePattern("x/*"), parsePattern("*/y")]);
  assert.deepEqual(alphabet, ["a", "x", "y"]);
  assert.deepEqual(exhaustiveWitness(parsePattern("x/*"), parsePattern("*/y"), [], alphabet, 3), [
    "x",
    "y",
  ]);
});

test("search and exhaustion agree on exclude-heavy cases", () => {
  const excludes = ["a", "b"].map(parsePattern);
  const search = searchIntersection(parsePattern("*"), parsePattern("*"), excludes);
  assert.equal(search.status, "common");
  if (search.status === "common") {
    assert.deepEqual(search.witness, ["c"]);
  }
});

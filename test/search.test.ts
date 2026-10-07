import { test } from "node:test";
import assert from "node:assert";
import { parsePattern } from "../src/pattern";
import { findWitness, SearchResult, smallestMissingLiteral } from "../src/search";

const p = (s: string) => parsePattern(s);
const run = (a: string, b: string, ex: string[] = [], opts = {}) =>
  findWitness(p(a), p(b), ex.map(p), opts);

function wit(r: SearchResult): string[] {
  assert.strictEqual(r.status, "witness");
  return (r as { path: string[] }).path;
}

test("smallestMissingLiteral picks the byte-smallest free string", () => {
  assert.strictEqual(smallestMissingLiteral(new Set()), "a");
  assert.strictEqual(smallestMissingLiteral(new Set(["a"])), "aa");
  assert.strictEqual(smallestMissingLiteral(new Set(["a", "aa", "ab"])), "aaa");
  assert.strictEqual(smallestMissingLiteral(new Set(["b"])), "a");
});

test("basic intersections", () => {
  assert.deepStrictEqual(run("a/b", "a/*"), {
    status: "witness",
    path: ["a", "b"],
    expansions: 2,
  });
  assert.deepStrictEqual(wit(run("a/*", "*/b")), ["a", "b"]);
  assert.deepStrictEqual(wit(run("**", "a")), ["a"]);
  assert.deepStrictEqual(wit(run("*", "a")), ["a"]);
  assert.deepStrictEqual(wit(run("a/**", "**/b")), ["a", "b"]);
});

test("empty intersections", () => {
  assert.strictEqual(run("a", "b").status, "empty");
  assert.strictEqual(run("a/b", "a").status, "empty");
  assert.strictEqual(run("*/x", "*/y").status, "empty");
  assert.strictEqual(run("**", "**", ["**"]).status, "empty");
});

test("empty path witness", () => {
  assert.deepStrictEqual(wit(run("**", "**")), []);
  assert.deepStrictEqual(wit(run("**", "**", ["a/b"])), []);
});

test("fewest segments wins over byte order", () => {
  // 'a' excluded, so the 1-segment witness is 'aa' (byte-next after 'a').
  assert.deepStrictEqual(wit(run("*", "**", ["a"])), ["aa"]);
});

test("byte order tie-break within the same segment count", () => {
  // 1-segment candidates: 'a', 'aa', 'ab' excluded, so 'aaa' beats 'b'.
  assert.deepStrictEqual(wit(run("*", "*", ["a", "aa", "ab"])), ["aaa"]);
  // literals participate in byte order too: 'a/x' beats 'b/x' and 'x/x'.
  assert.deepStrictEqual(wit(run("*/x", "**")), ["a", "x"]);
});

test("excludes force pumping past the naive witness", () => {
  // a/** allows 'a', 'a/x', ... but 'a' and 'a/*' are excluded, so the
  // shortest witness has 3 segments.
  assert.deepStrictEqual(wit(run("a/**", "**", ["a", "a/*"])), ["a", "a", "a"]);
});

test("excludes can empty a nonempty intersection", () => {
  assert.strictEqual(run("a/*", "*/b", ["a/b"]).status, "empty");
  assert.deepStrictEqual(wit(run("a/*", "**", ["a/b", "a/c"])), ["a", "a"]);
});

test("budget exhaustion reports unknown, not empty", () => {
  assert.strictEqual(run("a", "**", [], { budget: 0 }).status, "unknown");
  assert.strictEqual(run("a/**/b", "**/c/**", [], { budget: 1 }).status, "unknown");
});

test("depth limit degrades empty to unknown", () => {
  // 'a' and 'b' never intersect; with maxDepth 0 the frontier cannot be
  // explored, so the result must be unknown rather than empty.
  assert.strictEqual(run("a", "b", [], { maxDepth: 0 }).status, "unknown");
  assert.strictEqual(run("a", "b").status, "empty");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePattern } from "../src/pattern.js";
import { searchIntersection, type SearchResult } from "../src/search.js";
import { smallestNonLiteral } from "../src/alphabet.js";

const run = (a: string, b: string, excludes: string[] = [], budget?: number) =>
  searchIntersection(
    parsePattern(a),
    parsePattern(b),
    excludes.map(parsePattern),
    budget,
  );

const witnessOf = (res: SearchResult): string[] => {
  if (res.status !== "common") throw new Error(`expected common, got ${res.status}`);
  return res.witness;
};

test("common path with exact literals", () => {
  const res = run("a/b", "a/b");
  assert.deepEqual(res, { status: "common", witness: ["a", "b"], expansions: res.expansions });
});

test("disjoint literal prefixes", () => {
  assert.equal(run("a", "b").status, "disjoint");
  assert.equal(run("a/*", "b/*").status, "disjoint");
  assert.equal(run("a/b", "a").status, "disjoint");
});

test("star against literal pins the literal", () => {
  assert.deepEqual(witnessOf(run("a/*", "*/b")), ["a", "b"]);
  assert.deepEqual(witnessOf(run("*/a", "a/*")), ["a", "a"]);
});

test("double star interactions", () => {
  assert.deepEqual(witnessOf(run("**", "**")), []);
  assert.deepEqual(witnessOf(run("a/**", "**/b")), ["a", "b"]);
  assert.deepEqual(witnessOf(run("**/a", "**")), ["a"]);
  assert.deepEqual(witnessOf(run("a/**/b", "**/c/**")), ["a", "c", "b"]);
});

test("fewest segments wins over byte order", () => {
  // "z" (1 segment) beats "a/a" (2 segments).
  assert.deepEqual(witnessOf(run("**/z", "*/**")), ["z"]);
});

test("byte order breaks ties among equal-length witnesses", () => {
  assert.deepEqual(witnessOf(run("*/x", "*/*")), ["a", "x"]);
  assert.deepEqual(witnessOf(run("b/*", "b/*")), ["b", "a"]);
});

test("excludes force the next byte-smallest symbol", () => {
  assert.deepEqual(witnessOf(run("*", "*", ["a"])), ["b"]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
  assert.deepEqual(witnessOf(run("*", "*", alphabet)), ["aa"]);
});

test("excludes force a longer witness", () => {
  assert.deepEqual(witnessOf(run("a/**", "**", ["a", "a/*"])), ["a", "a", "a"]);
});

test("excludes can make the intersection empty", () => {
  assert.equal(run("**", "**", ["**"]).status, "disjoint");
  assert.equal(run("a/*", "a/*", ["a/*"]).status, "disjoint");
});

test("empty path survives excludes that need a segment", () => {
  assert.deepEqual(witnessOf(run("**", "**", ["*"])), []);
});

test("budget exhaustion reports unknown, not disjoint", () => {
  const res = run("a/**", "**/b", [], 1);
  assert.equal(res.status, "unknown");
  // The same query with a healthy budget is decidable.
  assert.equal(run("a/**", "**/b").status, "common");
});

test("smallestNonLiteral picks byte-minimal fresh strings", () => {
  assert.equal(smallestNonLiteral(new Set()), "a");
  assert.equal(smallestNonLiteral(new Set(["a"])), "b");
  assert.equal(smallestNonLiteral(new Set("abcdefghijklmnopqrstuvwxyz".split(""))), "aa");
});

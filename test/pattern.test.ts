import { test } from "node:test";
import assert from "node:assert";
import { parsePattern, PatternError, patternToString } from "../src/pattern";

test("parses literals, * and **", () => {
  assert.deepStrictEqual(parsePattern("a/*/b/**"), [
    { kind: "lit", value: "a" },
    { kind: "star" },
    { kind: "lit", value: "b" },
    { kind: "starstar" },
  ]);
  assert.strictEqual(patternToString(parsePattern("a/*/b/**")), "a/*/b/**");
});

test("single segment patterns", () => {
  assert.deepStrictEqual(parsePattern("abc"), [{ kind: "lit", value: "abc" }]);
  assert.deepStrictEqual(parsePattern("*"), [{ kind: "star" }]);
  assert.deepStrictEqual(parsePattern("**"), [{ kind: "starstar" }]);
});

test("rejects empty segments", () => {
  for (const bad of ["", "a//b", "/a", "a/", "//", "/"]) {
    assert.throws(() => parsePattern(bad), PatternError, JSON.stringify(bad));
  }
});

test("rejects malformed segments", () => {
  for (const bad of ["***", "a*", "*a", "a**b", "A", "a-b", "a1", "*.*"]) {
    assert.throws(() => parsePattern(bad), PatternError, JSON.stringify(bad));
  }
});

test("accepts exactly 12 segments, rejects 13", () => {
  assert.strictEqual(parsePattern(new Array(12).fill("a").join("/")).length, 12);
  assert.throws(() => parsePattern(new Array(13).fill("a").join("/")), PatternError);
});

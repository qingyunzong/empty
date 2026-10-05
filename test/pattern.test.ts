import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePattern, formatPattern, PatternError, MAX_SEGMENTS } from "../src/pattern.js";

test("parses literal, star and double-star segments", () => {
  assert.deepEqual(parsePattern("a/*/b/**"), [
    { kind: "lit", value: "a" },
    { kind: "star" },
    { kind: "lit", value: "b" },
    { kind: "dstar" },
  ]);
  assert.equal(formatPattern(parsePattern("a/*/b/**")), "a/*/b/**");
});

test("rejects empty segments", () => {
  for (const bad of ["", "/a", "a/", "a//b", "//", "**/"]) {
    assert.throws(() => parsePattern(bad), PatternError, bad);
  }
});

test("rejects partial or oversized wildcards", () => {
  for (const bad of ["a*", "*a", "***", "a**b", "*/*b"]) {
    assert.throws(() => parsePattern(bad), PatternError, bad);
  }
});

test("rejects non-lowercase-letter literals", () => {
  for (const bad of ["A", "a1", "a-b", "a.b", "a_b"]) {
    assert.throws(() => parsePattern(bad), PatternError, bad);
  }
});

test("rejects patterns longer than 12 segments", () => {
  const ok = new Array(MAX_SEGMENTS).fill("a").join("/");
  const tooLong = new Array(MAX_SEGMENTS + 1).fill("a").join("/");
  assert.equal(parsePattern(ok).length, MAX_SEGMENTS);
  assert.throws(() => parsePattern(tooLong), PatternError);
});

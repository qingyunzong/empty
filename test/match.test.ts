import { test } from "node:test";
import assert from "node:assert";
import { parsePattern } from "../src/pattern";
import { matchSegments } from "../src/match";

const m = (pat: string, path: string[]): boolean =>
  matchSegments(parsePattern(pat), path);

test("literal and * matching", () => {
  assert.strictEqual(m("a/b", ["a", "b"]), true);
  assert.strictEqual(m("a/b", ["a", "c"]), false);
  assert.strictEqual(m("a/b", ["a"]), false);
  assert.strictEqual(m("a/*", ["a", "zz"]), true);
  assert.strictEqual(m("a/*", ["a"]), false);
  assert.strictEqual(m("a/*", ["a", "b", "c"]), false);
});

test("** matches zero or more whole segments", () => {
  assert.strictEqual(m("**", []), true);
  assert.strictEqual(m("**", ["a"]), true);
  assert.strictEqual(m("**", ["a", "b", "c"]), true);
  assert.strictEqual(m("a/**", ["a"]), true);
  assert.strictEqual(m("a/**", ["a", "x", "y"]), true);
  assert.strictEqual(m("a/**", ["b"]), false);
  assert.strictEqual(m("a/**/b", ["a", "b"]), true);
  assert.strictEqual(m("a/**/b", ["a", "x", "y", "b"]), true);
  assert.strictEqual(m("a/**/b", ["a", "x", "y"]), false);
  assert.strictEqual(m("**/b", ["b"]), true);
  assert.strictEqual(m("**/b", ["x", "b"]), true);
});

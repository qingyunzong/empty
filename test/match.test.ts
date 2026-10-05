import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePattern } from "../src/pattern.js";
import { matchPath } from "../src/match.js";

const m = (pattern: string, path: string[]): boolean => matchPath(parsePattern(pattern), path);

test("literal and star matching", () => {
  assert.equal(m("a/b", ["a", "b"]), true);
  assert.equal(m("a/b", ["a", "c"]), false);
  assert.equal(m("a/b", ["a"]), false);
  assert.equal(m("a/*", ["a", "zz"]), true);
  assert.equal(m("*/a", ["a", "a"]), true);
});

test("double star matches zero or more segments", () => {
  assert.equal(m("a/**", ["a"]), true);
  assert.equal(m("a/**", ["a", "b", "c"]), true);
  assert.equal(m("**/b", ["b"]), true);
  assert.equal(m("**/b", ["x", "y", "b"]), true);
  assert.equal(m("**", []), true);
  assert.equal(m("**", ["q"]), true);
  assert.equal(m("a/**/b", ["a", "b"]), true);
  assert.equal(m("a/**/b", ["a", "m", "n", "b"]), true);
  assert.equal(m("a/**/b", ["a", "m", "n"]), false);
});

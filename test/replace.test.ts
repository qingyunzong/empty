import { test } from "node:test";
import assert from "node:assert/strict";
import {
  replaceAll,
  findMatches,
  ReplaceSession,
  InvalidCaptureError,
  InvalidMatchesError,
  BudgetExceededError,
} from "../src/index.js";

test("basic replacement maps output back to source", () => {
  const { text, map } = replaceAll(
    "hello world",
    [{ start: 6, end: 11 }],
    "[$&]",
  );
  assert.equal(text, "hello [world]");
  assert.equal(map.sourcePositionAt(0), 0); // 'h' copied
  assert.equal(map.sourcePositionAt(6), null); // '[' inserted
  assert.equal(map.sourcePositionAt(7), 6); // 'w'
  assert.equal(map.sourcePositionAt(11), 10); // 'd'
  assert.equal(map.sourcePositionAt(12), null); // ']' inserted
});

test("capture groups expand in template order", () => {
  const { text, map } = replaceAll(
    "John Smith",
    [
      {
        start: 0,
        end: 10,
        captures: [undefined, { start: 0, end: 4 }, { start: 5, end: 10 }],
      },
    ],
    "$2, $1",
  );
  assert.equal(text, "Smith, John");
  assert.equal(map.sourcePositionAt(0), 5); // 'S' of Smith
  assert.equal(map.sourcePositionAt(5), null); // ',' inserted
  assert.equal(map.sourcePositionAt(7), 0); // 'J'
});

test("zero-length match inserts template output", () => {
  const { text, map } = replaceAll("ab", [{ start: 1, end: 1 }], "-");
  assert.equal(text, "a-b");
  assert.equal(map.sourcePositionAt(0), 0);
  assert.equal(map.sourcePositionAt(1), null);
  assert.equal(map.sourcePositionAt(2), 1);
});

test("invalid capture reference rejects the whole operation", () => {
  assert.throws(
    () => replaceAll("abc", [{ start: 0, end: 1 }], "$1"),
    InvalidCaptureError,
  );
  // Referencing a group that did not participate is also invalid.
  assert.throws(
    () =>
      replaceAll("abc", [
        { start: 0, end: 1, captures: [undefined, undefined] },
      ], "$1"),
    InvalidCaptureError,
  );
});

test("overlapping or unsorted matches are rejected", () => {
  assert.throws(
    () =>
      replaceAll("abcdef", [
        { start: 0, end: 3 },
        { start: 2, end: 4 },
      ], "x"),
    InvalidMatchesError,
  );
  assert.throws(
    () =>
      replaceAll("abcdef", [
        { start: 3, end: 4 },
        { start: 0, end: 1 },
      ], "x"),
    InvalidMatchesError,
  );
});

test("budget limits expansion length and failure keeps session intact", () => {
  const session = new ReplaceSession("aaaa");
  const matches = [{ start: 0, end: 4 }];
  assert.throws(
    () => session.apply(matches, "$&$&$&", { budget: 10 }),
    BudgetExceededError,
  );
  assert.equal(session.text, "aaaa"); // unchanged
  assert.equal(session.depth, 0);
  // Exactly at the budget it succeeds.
  session.apply(matches, "$&$&$&", { budget: 12 });
  assert.equal(session.text, "aaaaaaaaaaaa");
});

test("findMatches advances one code point after zero-length matches", () => {
  const matches = findMatches("😀x", /a*/);
  // Empty matches at 0, 2, 3: index 1 (inside the surrogate pair) is skipped.
  assert.deepEqual(
    matches.map((m) => [m.start, m.end]),
    [
      [0, 0],
      [2, 2],
      [3, 3],
    ],
  );
});

test("findMatches reports capture ranges and non-participating groups", () => {
  const matches = findMatches("xabac", /(a)(b)?/);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0].captures, [
    { start: 1, end: 3 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]);
  assert.equal(matches[1].captures?.[2], undefined);
  // $2 is valid for the first match but not the second: reject everything.
  assert.throws(
    () => replaceAll("xabac", matches, "$2"),
    InvalidCaptureError,
  );
  const { text } = replaceAll("xabac", matches, "<$1>");
  assert.equal(text, "x<a><a>c");
});

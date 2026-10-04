import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, encodeArg, decode } from "../src/quote.js";

test("round-trips tricky values: empty, quotes, newlines", () => {
  const values = [
    "",
    "'",
    "''",
    "\n",
    "a\nb\n",
    "it's",
    "a b",
    "\t",
    "\\",
    "\\n",
    '"',
    "$HOME",
    "`uname`",
    "@file.rsp",
    "@",
    "-",
    "--flag=value",
    "中文参数",
  ];
  for (const value of values) {
    assert.deepEqual(decode(encode([value])), [value], `round-trip ${JSON.stringify(value)}`);
  }
});

test("known encodings", () => {
  assert.equal(encodeArg(""), "''");
  assert.equal(encodeArg("it's"), "'it'\\''s'");
  assert.equal(encodeArg("a b"), "'a b'");
  assert.equal(encodeArg("a\nb"), "'a\nb'");
  assert.equal(encodeArg("plain-1_2.3"), "plain-1_2.3");
  assert.equal(encodeArg("@x"), "'@x'");
  assert.equal(encode(["a", "", "b"]), "a '' b");
  assert.equal(encode([]), "");
});

test("NUL is forbidden in both directions", () => {
  assert.throws(() => encodeArg("a\0b"), /NUL/);
  assert.throws(() => encode(["ok", "bad\0"]), /NUL/);
  assert.throws(() => decode("a\0b"), /NUL/);
});

test("independent decoder: double quotes, backslashes, errors", () => {
  assert.deepEqual(decode(`"a b" 'c d' e\\ f`), ["a b", "c d", "e f"]);
  assert.deepEqual(decode(`"a\\"b"`), ['a"b']);
  assert.deepEqual(decode(`"\\$HOME"`), ["$HOME"]);
  assert.deepEqual(decode("  a   b  "), ["a", "b"]);
  assert.deepEqual(decode(""), []);
  assert.deepEqual(decode("''"), [""]);
  assert.throws(() => decode("'unterminated"), /unterminated single quote/);
  assert.throws(() => decode('"unterminated'), /unterminated double quote/);
  assert.throws(() => decode("trail\\"), /trailing backslash/);
});

function* shortStrings(alphabet: readonly string[], maxLen: number): Generator<string> {
  yield "";
  if (maxLen === 0) return;
  for (const rest of shortStrings(alphabet, maxLen - 1)) {
    for (const ch of alphabet) {
      yield ch + rest;
    }
  }
}

// 7 tricky characters, every string up to length 3: 1 + 7 + 49 + 343 = 400.
const ALPHABET = ["a", "'", '"', "\\", " ", "\n", "@"];
const ALL = [...shortStrings(ALPHABET, 3)];
assert.equal(ALL.length, 400);

test("exhaustive round-trip over the short charset (single argument)", () => {
  for (const s of ALL) {
    assert.deepEqual(decode(encode([s])), [s], `round-trip ${JSON.stringify(s)}`);
  }
});

test("exhaustive concatenation never changes argument count (400 x 400 pairs)", () => {
  for (const a of ALL) {
    const ea = encodeArg(a);
    for (const b of ALL) {
      const joined = ea + " " + encodeArg(b);
      const decoded = decode(joined);
      assert.equal(decoded.length, 2, `count for ${JSON.stringify([a, b])}`);
      assert.deepEqual(decoded, [a, b]);
    }
  }
});

// 4 characters, every string up to length 3: 85 values, all 85^3 triples.
const SMALL = [...shortStrings(["'", "\\", " ", "x"], 3)];

test("exhaustive triples round-trip with stable count", () => {
  for (const a of SMALL) {
    for (const b of SMALL) {
      for (const c of SMALL) {
        assert.deepEqual(decode(encode([a, b, c])), [a, b, c]);
      }
    }
  }
});

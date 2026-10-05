import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTemplate, InvalidCaptureError } from "../src/index.js";

test("parses literals and capture references", () => {
  assert.deepEqual(parseTemplate("a$1b"), [
    { kind: "literal", text: "a" },
    { kind: "capture", index: 1 },
    { kind: "literal", text: "b" },
  ]);
});

test("$$ is a literal dollar, $& and $0 mean the whole match", () => {
  assert.deepEqual(parseTemplate("$$$&$0"), [
    { kind: "literal", text: "$" },
    { kind: "capture", index: 0 },
    { kind: "capture", index: 0 },
  ]);
});

test("two-digit capture references are parsed greedily", () => {
  assert.deepEqual(parseTemplate("$12"), [{ kind: "capture", index: 12 }]);
  assert.deepEqual(parseTemplate("$1x2"), [
    { kind: "capture", index: 1 },
    { kind: "literal", text: "x2" },
  ]);
});

test("malformed dollar references are rejected", () => {
  assert.throws(() => parseTemplate("$x"), InvalidCaptureError);
  assert.throws(() => parseTemplate("trailing $"), InvalidCaptureError);
  assert.throws(() => parseTemplate("$-1"), InvalidCaptureError);
});

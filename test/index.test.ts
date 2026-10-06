import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentIndex } from "../src/index.ts";

test("headings get sequential IDs with duplicate numbering", () => {
  const idx = DocumentIndex.fromText(
    ["# Hello World", "some text", "## Hello World", "# hello  world"].join("\n"),
  );
  assert.deepEqual(
    idx.headings.map((h) => [h.line, h.level, h.id]),
    [
      [0, 1, "hello-world"],
      [2, 2, "hello-world-1"],
      [3, 1, "hello-world-2"],
    ],
  );
});

test("fenced code blocks are ignored", () => {
  const idx = DocumentIndex.fromText(
    ["# Real", "```", "# Fake", '<a name="nope"></a>', "[x](#fake)", "```", "# Also Real"].join(
      "\n",
    ),
  );
  assert.deepEqual(
    idx.headings.map((h) => h.id),
    ["real", "also-real"],
  );
  assert.equal(idx.anchors.length, 0);
  assert.equal(idx.references.length, 0);
});

test("unclosed fence swallows the rest of the document", () => {
  const idx = DocumentIndex.fromText(["# A", "~~~", "# B", "# C"].join("\n"));
  assert.deepEqual(
    idx.headings.map((h) => h.text),
    ["A"],
  );
});

test("references may be forward and resolve globally", () => {
  const idx = DocumentIndex.fromText(
    [
      "[fwd](#later) [anch](#named) [bad](#missing)",
      '<a name="named"></a>',
      "# Later",
    ].join("\n"),
  );
  assert.deepEqual(
    idx.references.map((r) => [r.target, r.resolved]),
    [
      ["later", true],
      ["named", true],
      ["missing", false],
    ],
  );
});

test("reference targets match generated heading IDs", () => {
  const idx = DocumentIndex.fromText(["[go](#my-section)", "# My Section"].join("\n"));
  assert.equal(idx.references[0].resolved, true);
});

test("edit validation", () => {
  const idx = DocumentIndex.fromText("a\nb");
  assert.throws(() => idx.edit(-1, 0, []), RangeError);
  assert.throws(() => idx.edit(3, 0, []), RangeError);
  assert.throws(() => idx.edit(1, 5, []), RangeError);
  idx.edit(2, 0, ["c"]); // append at end is fine
  assert.equal(idx.getText(), "a\nb\nc");
});

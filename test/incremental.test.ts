import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentIndex, type Snapshot } from "../src/index.ts";

function assertConsistent(idx: DocumentIndex, expectedText: string): void {
  assert.equal(idx.getText(), expectedText, "text after edit");
  const full = DocumentIndex.fromText(expectedText).snapshot();
  const inc: Snapshot = idx.snapshot();
  assert.deepEqual(inc, full, "incremental result must equal full re-scan");
}

test("edit strictly inside a fence that spans the edit region", () => {
  const idx = DocumentIndex.fromText(
    ["# A", "```", "# hidden", "still hidden", "```", "# B"].join("\n"),
  );
  idx.edit(2, 2, ["# also hidden", "[x](#nope)"]);
  assertConsistent(idx, ["# A", "```", "# also hidden", "[x](#nope)", "```", "# B"].join("\n"));
  assert.deepEqual(
    idx.headings.map((h) => h.id),
    ["a", "b"],
  );
});

test("edit that opens a fence hides following headings", () => {
  const before = ["# A", "# B", "# C"].join("\n");
  const idx = DocumentIndex.fromText(before);
  idx.edit(1, 0, ["```"]);
  assertConsistent(idx, ["# A", "```", "# B", "# C"].join("\n"));
  assert.deepEqual(
    idx.headings.map((h) => h.text),
    ["A"],
  );
});

test("edit that closes a fence reveals following headings", () => {
  const idx = DocumentIndex.fromText(["# A", "```", "# hidden", "# also hidden"].join("\n"));
  idx.edit(1, 1, []);
  assertConsistent(idx, ["# A", "# hidden", "# also hidden"].join("\n"));
  assert.equal(idx.headings.length, 3);
});

test("edit before a fence keeps the fence intact", () => {
  const idx = DocumentIndex.fromText(["# A", "```", "# hidden", "```", "# B"].join("\n"));
  idx.edit(0, 1, ["# A2", "paragraph", "## Sub"]);
  assertConsistent(idx, ["# A2", "paragraph", "## Sub", "```", "# hidden", "```", "# B"].join("\n"));
  assert.deepEqual(
    idx.headings.map((h) => h.id),
    ["a2", "sub", "b"],
  );
});

test("duplicate numbering shifts after insertion and deletion", () => {
  const idx = DocumentIndex.fromText(["# Dup", "# Dup", "# Dup"].join("\n"));
  idx.edit(0, 0, ["# Dup"]);
  assert.deepEqual(
    idx.headings.map((h) => h.id),
    ["dup", "dup-1", "dup-2", "dup-3"],
  );
  idx.edit(0, 2, []);
  assert.deepEqual(
    idx.headings.map((h) => h.id),
    ["dup", "dup-1"],
  );
});

test("replacing a heading re-resolves references", () => {
  const idx = DocumentIndex.fromText(["[r](#old)", "# Old"].join("\n"));
  assert.equal(idx.references[0].resolved, true);
  idx.edit(1, 1, ["# New"]);
  assert.equal(idx.references[0].resolved, false);
  idx.edit(1, 1, ["# Old"]);
  assert.equal(idx.references[0].resolved, true);
});

test("string edit payload and CRLF normalization", () => {
  const idx = DocumentIndex.fromText("# A\r\n# B");
  idx.edit(1, 1, "# C\r\n# D");
  assertConsistent(idx, "# A\n# C\n# D");
});

// --- Randomized differential test: incremental edits vs full re-scan ---

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  "# Title",
  "## Sub Section",
  "### Deep One",
  "# Title", // duplicate on purpose
  "plain text",
  "",
    "   ",
  "[link](#title)",
  "[fwd](#later-anchor)",
  "[bad](#missing)",
  '<a name="later-anchor"></a>',
  '<a id="by-id"></a>',
  "```",
  "```js",
  "````",
  "~~~",
  "~~~ info",
  "# Inside Fence",
  '<a name="hidden-anchor"></a>',
  "[hidden](#nope)",
  "    # indented code",
  "   # three space heading",
  "## Closed ##",
  "#nospace",
];

test("random edits always match a full re-scan", () => {
  for (let iter = 0; iter < 150; iter++) {
    const rand = mulberry32(iter * 2654435761);
    const pick = () => VOCAB[Math.floor(rand() * VOCAB.length)];

    const truth: string[] = [];
    const n = 1 + Math.floor(rand() * 30);
    for (let i = 0; i < n; i++) truth.push(pick());

    const idx = DocumentIndex.fromText(truth.join("\n"));
    assertConsistent(idx, truth.join("\n"));

    for (let e = 0; e < 25; e++) {
      const start = Math.floor(rand() * (truth.length + 1));
      const del = Math.floor(rand() * Math.min(6, truth.length - start + 1));
      const ins: string[] = [];
      const insCount = Math.floor(rand() * 6);
      for (let k = 0; k < insCount; k++) ins.push(pick());

      idx.edit(start, del, ins);
      truth.splice(start, del, ...ins);
      assertConsistent(idx, truth.join("\n"));
    }
  }
});

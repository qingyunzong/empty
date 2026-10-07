import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentIndex, scan, slugify } from "../src/index";

function snapshotOf(doc: DocumentIndex) {
  return { headings: doc.headings, anchors: doc.anchors, references: doc.references };
}

/** Apply the same edit to a plain string, then full-scan it. */
function fullScanAfterEdit(text: string, start: number, del: number, inserted: string[]) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  lines.splice(start, del, ...inserted);
  return { text: lines.join("\n"), snap: scan(lines.join("\n")) };
}

test("slugify: lowercase ASCII and whitespace collapsing", () => {
  assert.equal(slugify("Hello   World"), "hello-world");
  assert.equal(slugify("  Multiple\t \n Spaces "), "multiple-spaces");
  assert.equal(slugify("Punctuation, Gone!"), "punctuation-gone");
  assert.equal(slugify("Keep_Underscore-and-dash"), "keep_underscore-and-dash");
  assert.equal(slugify("中文标题 ABC"), "abc");
});

test("extracts ATX headings with levels and generated ids", () => {
  const doc = new DocumentIndex("# Title\n\n## Section One\n\ntext\n\n### Sub Section\n");
  assert.deepEqual(
    doc.headings.map((h) => [h.level, h.text, h.id, h.line]),
    [
      [1, "Title", "title", 0],
      [2, "Section One", "section-one", 2],
      [3, "Sub Section", "sub-section", 6],
    ],
  );
});

test("duplicate headings get numeric suffixes", () => {
  const doc = new DocumentIndex("# Intro\n\n# Intro\n\n# Intro\n\n# Intro-1\n");
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["intro", "intro-1", "intro-2", "intro-1-1"],
  );
});

test("heading text is cleaned of inline markup before slugging", () => {
  const doc = new DocumentIndex("## The `code` and **bold** [link](http://x) ##\n");
  assert.equal(doc.headings[0]!.id, "the-code-and-bold-link");
});

test("content inside fenced code blocks is ignored", () => {
  const text = [
    "# Real",
    "```markdown",
    "# Fake Heading",
    '<a name="fake-anchor">',
    "[fake](#fake-anchor)",
    "```",
    "## Also Real",
    "~~~",
    "# Tilde Fake",
    "~~~",
  ].join("\n");
  const doc = new DocumentIndex(text);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["real", "also-real"],
  );
  assert.equal(doc.getAnchor("fake-anchor"), undefined);
  assert.equal(doc.references.length, 0);
});

test("closing fence must match char and be at least as long", () => {
  const text = ["````", "# Hidden", "```", "# Still Hidden", "````", "# Visible"].join("\n");
  const doc = new DocumentIndex(text);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["visible"],
  );
});

test("explicit anchors via <a name> and <a id>", () => {
  const doc = new DocumentIndex('<a name="top"></a>\n\n<a id=\'sec-2\'>x</a>\n');
  assert.deepEqual(doc.getAnchor("top"), { name: "top", line: 0 });
  assert.deepEqual(doc.getAnchor("sec-2"), { name: "sec-2", line: 2 });
});

test("references resolve, including forward references", () => {
  const text = [
    "See [later](#appendix) and [missing](#nope).",
    "",
    "## Appendix",
  ].join("\n");
  const doc = new DocumentIndex(text);
  assert.equal(doc.references.length, 2);
  const [fwd, dangling] = doc.references;
  assert.equal(fwd!.target, "appendix");
  assert.equal(fwd!.resolved, true, "forward reference resolves");
  assert.equal(dangling!.resolved, false);
});

test("references to explicit anchors resolve", () => {
  const doc = new DocumentIndex('[go](#target)\n\n<a name="target"></a>\n');
  assert.equal(doc.references[0]!.resolved, true);
});

test("edit a heading line updates ids and dedup numbering", () => {
  const doc = new DocumentIndex("# A\n\n# A\n");
  doc.edit(0, 1, ["# B"]);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["b", "a"],
  );
});

test("edit that opens a fence hides following headings (fence spans edit region)", () => {
  const before = ["intro", "# Top", "", "# Bottom", "end"].join("\n");
  const doc = new DocumentIndex(before);
  assert.equal(doc.headings.length, 2);
  // Insert an opening fence above the headings: it swallows lines beyond the edit.
  doc.edit(1, 0, ["```"]);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    [],
  );
  assert.deepEqual(snapshotOf(doc), scan(doc.toText()));
});

test("edit that closes a fence reveals following headings", () => {
  const doc = new DocumentIndex(["```", "# Hidden", "tail"].join("\n"));
  assert.equal(doc.headings.length, 0);
  doc.edit(2, 1, ["```", "# Shown"]);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["shown"],
  );
  assert.deepEqual(snapshotOf(doc), scan(doc.toText()));
});

test("edit inside a fence stays ignored", () => {
  const doc = new DocumentIndex(["```", "# Hidden", "```", "# Shown"].join("\n"));
  doc.edit(1, 1, ["# Still Hidden", "## Also Hidden"]);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["shown"],
  );
  assert.deepEqual(snapshotOf(doc), scan(doc.toText()));
});

test("deleting a fence opener turns the old closer into an opener", () => {
  const doc = new DocumentIndex(["```", "code", "```", "# After"].join("\n"));
  doc.edit(0, 1, []);
  // The former closing fence now opens a new block, so the heading stays
  // hidden — exactly what a full re-scan produces.
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    [],
  );
  assert.deepEqual(snapshotOf(doc), scan(doc.toText()));
  // Deleting the remaining fence reveals the heading again.
  doc.edit(1, 1, []);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["after"],
  );
  assert.deepEqual(snapshotOf(doc), scan(doc.toText()));
});

test("sequential edits stay consistent with full scans", () => {
  const doc = new DocumentIndex("# One\n\n# Two\n\n[x](#three)\n");
  doc.edit(4, 0, ["# Three"]);
  assert.equal(doc.references[0]!.resolved, true);
  doc.edit(0, 1, ["# Three"]);
  assert.deepEqual(
    doc.headings.map((h) => h.id),
    ["three", "two", "three-1"],
  );
  assert.deepEqual(snapshotOf(doc), scan(doc.toText()));
});

test("edit validates ranges", () => {
  const doc = new DocumentIndex("a\nb\n");
  assert.throws(() => doc.edit(-1, 0, ["x"]), RangeError);
  assert.throws(() => doc.edit(doc.lineCount + 1, 0, ["x"]), RangeError);
  assert.throws(() => doc.edit(1, 5, []), RangeError);
  doc.edit(doc.lineCount, 0, ["c"]); // appending at lineCount is allowed
  assert.equal(doc.lineCount, 4);
});

/* ---------------- fuzz: incremental edits vs full re-scan ---------------- */

function mulberry32(seed: number) {
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
  "# Alpha",
  "## Beta Gamma",
  "### Alpha",
  "plain text line",
  "[ref](#alpha)",
  "[fwd](#omega)",
  "[bad](#missing)",
  '<a name="omega"></a>',
  '<a id="custom-1">x</a>',
  "```",
  "```markdown",
  "````",
  " ",
  "~~~",
  "# Inside Fence",
  "[fence-ref](#nope)",
  "``````",
  "",
    "trailing spaces   ",
  "# Alpha",
];

function randomLines(rand: () => number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(VOCAB[Math.floor(rand() * VOCAB.length)]!);
  return out;
}

test("fuzz: random edits always match a full re-scan", () => {
  const rand = mulberry32(20261007);
  for (let iter = 0; iter < 400; iter++) {
    let lines = randomLines(rand, 1 + Math.floor(rand() * 30));
    const doc = new DocumentIndex(lines.join("\n"));
    const edits = 1 + Math.floor(rand() * 6);
    for (let e = 0; e < edits; e++) {
      const start = Math.floor(rand() * (lines.length + 1));
      const maxDel = lines.length - start;
      const del = Math.floor(rand() * (maxDel + 1));
      const inserted = randomLines(rand, Math.floor(rand() * 8));
      doc.edit(start, del, inserted);
      lines.splice(start, del, ...inserted);
      const text = lines.join("\n");
      assert.equal(doc.toText(), text, `iter ${iter} edit ${e}: text mismatch`);
      assert.deepEqual(
        snapshotOf(doc),
        scan(text),
        `iter ${iter} edit ${e}: index mismatch\nstart=${start} del=${del} inserted=${JSON.stringify(inserted)}\ndoc:\n${text}`,
      );
    }
  }
});

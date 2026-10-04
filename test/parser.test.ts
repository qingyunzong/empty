import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { parse, parseChunks, type ElementNode, type TextNode } from "../src/index.js";

function texts(node: { children: unknown[] }): string[] {
  return (node.children as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text as string);
}

test("basic paragraph with inline formatting", () => {
  const { root, diagnostics } = parse("<p>Hello <b>world</b>!</p>");
  equal(diagnostics.length, 0);
  equal(root.children.length, 1);
  const p = root.children[0] as ElementNode;
  equal(p.tag, "p");
  equal(p.start, 0);
  equal(p.end, 26);
  deepEqual(texts(p), ["Hello ", "!"]);
  const b = p.children[1] as ElementNode;
  equal(b.tag, "b");
  deepEqual(texts(b), ["world"]);
});

test("a new <p> implicitly closes an open <p>", () => {
  const { root, diagnostics } = parse("<p>one<p>two");
  equal(diagnostics.length, 0);
  equal(root.children.length, 2);
  const [first, second] = root.children as [ElementNode, ElementNode];
  equal(first.tag, "p");
  equal(second.tag, "p");
  deepEqual(texts(first), ["one"]);
  deepEqual(texts(second), ["two"]);
  equal(first.end, null); // closed implicitly
});

test("implicit <p> close also closes elements nested inside it", () => {
  const { root } = parse("<p>a<b>b<p>c");
  equal(root.children.length, 2);
  const [first, second] = root.children as [ElementNode, ElementNode];
  const b = first.children[1] as ElementNode;
  equal(b.tag, "b");
  deepEqual(texts(b), ["b"]);
  deepEqual(texts(second), ["c"]);
});

test("closing a tag that is not open is ignored and reported", () => {
  const { root, diagnostics } = parse("x</b>y");
  equal(diagnostics.length, 1);
  equal(diagnostics[0]!.code, "unmatched-close");
  equal(diagnostics[0]!.offset, 1);
  deepEqual(texts(root), ["x", "y"]);
});

test("closing an outer tag implicitly closes inner ones", () => {
  const { root, diagnostics } = parse("<p><b>bold</p>after");
  equal(diagnostics.length, 0);
  const p = root.children[0] as ElementNode;
  const b = p.children[0] as ElementNode;
  equal(b.tag, "b");
  equal(b.end, null); // implicit
  deepEqual(texts(root), ["after"]);
});

test("unsupported tags are ignored and reported", () => {
  const { root, diagnostics } = parse("<div>hi</div>");
  deepEqual(
    diagnostics.map((d) => d.code),
    ["unsupported-tag", "unmatched-close"],
  );
  deepEqual(texts(root), ["hi"]);
});

test("void <br> and self-closing tags have no children", () => {
  const { root, diagnostics } = parse("<p>a<br>b</p><i/>");
  equal(diagnostics.length, 0);
  const p = root.children[0] as ElementNode;
  const br = p.children[1] as ElementNode;
  equal(br.tag, "br");
  equal(br.children.length, 0);
  equal(br.end, 8);
  const i = root.children[1] as ElementNode;
  equal(i.tag, "i");
  equal(i.children.length, 0);
});

test("entities are decoded and keep their original byte mapping", () => {
  const { root, diagnostics } = parse("a &amp; b");
  equal(diagnostics.length, 0);
  const text = root.children[0] as TextNode;
  equal(text.text, "a & b");
  equal(text.start, 0);
  equal(text.end, 9); // raw source span, not decoded length
  deepEqual(text.entities, [{ start: 2, end: 7, decoded: "&" }]);
});

test("numeric entities decode decimal and hex", () => {
  const { root } = parse("&#65;&#x42;&lt;");
  const text = root.children[0] as TextNode;
  equal(text.text, "AB<");
  deepEqual(
    text.entities.map((e) => [e.start, e.end]),
    [
      [0, 5],
      [5, 11],
      [11, 15],
    ],
  );
});

test("unknown entities stay literal", () => {
  const { root, diagnostics } = parse("a &foo; b & c");
  equal(diagnostics.length, 0);
  const text = root.children[0] as TextNode;
  equal(text.text, "a &foo; b & c");
  equal(text.entities.length, 0);
});

test("entity byte mapping stays correct after multibyte characters", () => {
  const input = "é&amp;x";
  const { root } = parse(input);
  const text = root.children[0] as TextNode;
  equal(text.text, "é&x");
  deepEqual(text.entities, [{ start: 1, end: 6, decoded: "&" }]);
  equal(input.slice(1, 6), "&amp;");
});

test("attributes on supported tags are ignored", () => {
  const { root, diagnostics } = parse('<p class="x">hi</p>');
  equal(diagnostics.length, 0);
  const p = root.children[0] as ElementNode;
  deepEqual(texts(p), ["hi"]);
});

test("unterminated tag at end of input is literal text plus diagnostic", () => {
  const { root, diagnostics } = parse("abc<");
  deepEqual(texts(root), ["abc<"]);
  equal(diagnostics.length, 1);
  equal(diagnostics[0]!.code, "unterminated-tag");
  equal(diagnostics[0]!.offset, 3);
});

test("lone '<' before junk is literal text", () => {
  const { root, diagnostics } = parse("a < b");
  equal(diagnostics.length, 0);
  deepEqual(texts(root), ["a < b"]);
});

test("elements left open at EOF are closed implicitly without diagnostics", () => {
  const { root, diagnostics } = parse("<p><b>x");
  equal(diagnostics.length, 0);
  const p = root.children[0] as ElementNode;
  const b = p.children[0] as ElementNode;
  equal(b.tag, "b");
  equal(b.end, null);
  deepEqual(texts(b), ["x"]);
});

test("diagnostics keep source order", () => {
  const { diagnostics } = parse("</i><u>x</b>");
  deepEqual(
    diagnostics.map((d) => [d.offset, d.code]),
    [
      [0, "unmatched-close"],
      [4, "unsupported-tag"],
      [8, "unmatched-close"],
    ],
  );
});

const CORPUS: string[] = [
  "",
  "plain text only",
  "<p>Hello <b>world</b>!</p>",
  "<p>one<p>two<p>three",
  "<p>a<b>b<p>c</b>d",
  "x</b>y</p>z",
  "<div>hi</div><span/>",
  "a &amp; b &#65; &#x42; &foo; &",
  "<p>a<br>b</p><i/><b/>",
  "abc<",
  "abc</",
  "abc<def",
  "a < b <3",
  '<p class="a>b">hi</p>',
  "é&amp;<b>中文</b>&lt;",
  "<p><b><i>deep</i></b></p>",
  "</i><u>x</b>",
  "<p>unclosed",
];

test("chunked input yields identical events, tree and diagnostics", () => {
  for (const input of CORPUS) {
    const once = parse(input);
    // Every possible two-chunk split.
    for (let i = 0; i <= input.length; i++) {
      const chunked = parseChunks([input.slice(0, i), input.slice(i)]);
      deepEqual(chunked.events, once.events, `events differ for split ${i} of ${JSON.stringify(input)}`);
      deepEqual(chunked.root, once.root, `tree differs for split ${i} of ${JSON.stringify(input)}`);
      deepEqual(chunked.diagnostics, once.diagnostics, `diagnostics differ for split ${i} of ${JSON.stringify(input)}`);
    }
    // Fixed-size chunks of 1..4 plus random splits.
    for (const size of [1, 2, 3, 4]) {
      const chunks: string[] = [];
      for (let i = 0; i < input.length; i += size) chunks.push(input.slice(i, i + size));
      const chunked = parseChunks(chunks);
      deepEqual(chunked.events, once.events, `events differ for size ${size} of ${JSON.stringify(input)}`);
      deepEqual(chunked.root, once.root, `tree differs for size ${size} of ${JSON.stringify(input)}`);
      deepEqual(chunked.diagnostics, once.diagnostics, `diagnostics differ for size ${size} of ${JSON.stringify(input)}`);
    }
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 5; round++) {
      const chunks: string[] = [];
      let i = 0;
      while (i < input.length) {
        const n = 1 + Math.floor(rand() * 7);
        chunks.push(input.slice(i, i + n));
        i += n;
      }
      const chunked = parseChunks(chunks);
      deepEqual(chunked.events, once.events, `events differ for random split of ${JSON.stringify(input)}`);
      deepEqual(chunked.root, once.root, `tree differs for random split of ${JSON.stringify(input)}`);
      deepEqual(chunked.diagnostics, once.diagnostics, `diagnostics differ for random split of ${JSON.stringify(input)}`);
    }
  }
});

test("entities split across chunk boundaries decode identically", () => {
  const once = parse("x&amp;y");
  for (let i = 0; i <= 7; i++) {
    const chunked = parseChunks(["x&amp;y".slice(0, i), "x&amp;y".slice(i)]);
    deepEqual(chunked.root, once.root);
    deepEqual(chunked.diagnostics, once.diagnostics);
  }
  const text = once.root.children[0] as TextNode;
  equal(text.text, "x&y");
  deepEqual(text.entities, [{ start: 1, end: 6, decoded: "&" }]);
});

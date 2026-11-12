import test from "node:test";
import assert from "node:assert/strict";

import {
  extractTextSegments,
  type ReadNode,
  type SourceRange,
  type TextSegment,
} from "../index.js";

const BLOCK_TAGS: ReadonlySet<string> = new Set(["p", "div"]);

function text(data: string): ReadNode {
  return { text: true, data, tag: null, children: [] };
}

function el(tag: string, children: readonly ReadNode[], hidden = false): ReadNode {
  return { text: false, data: null, tag, hidden, children };
}

/** 拼接所有输出码点，得到纯文本参考结果。 */
function plainText(segments: readonly TextSegment[]): string {
  return segments.map((segment) => segment.codepoint).join("");
}

/** 逐码点参考断言：输出长度、码点顺序、换行标记、来源区间完全一致。 */
function assertCharwise(
  segments: readonly TextSegment[],
  expected: readonly (string | null)[],
): void {
  assert.equal(segments.length, expected.length, "输出码点数量");
  for (let i = 0; i < expected.length; i += 1) {
    const segment = segments[i] as TextSegment;
    const item = expected[i] as string | null;
    if (item === null) {
      assert.equal(segment.codepoint, "\n");
      assert.equal(segment.isNewline, true);
      assert.equal(segment.sources, null);
    } else {
      assert.equal(segment.codepoint, item);
      assert.equal(segment.isNewline, false);
      assert.ok(segment.sources !== null && segment.sources.length >= 1);
    }
  }
}

/** 断言单个非换行区段的来源区间集合。 */
function assertRanges(
  segment: TextSegment,
  expected: readonly SourceRange[],
): void {
  assert.equal(segment.isNewline, false);
  assert.deepEqual(segment.sources, expected);
}

function range(node: ReadNode, start: number, end: number): SourceRange {
  return { node, start, end };
}

test("纯文本节点：逐码点输出并保留 UTF-16 半开区间", () => {
  const node = text("abc");
  const segments = extractTextSegments(node, BLOCK_TAGS);

  assertCharwise(segments, ["a", "b", "c"]);
  assertRanges(segments[0] as TextSegment, [range(node, 0, 1)]);
  assertRanges(segments[1] as TextSegment, [range(node, 1, 2)]);
  assertRanges(segments[2] as TextSegment, [range(node, 2, 3)]);
});

test("ASCII 空白连续压成一个空格，保留全部来源区间", () => {
  const node = text("a \t\r\n\fb");
  const segments = extractTextSegments(node, BLOCK_TAGS);

  assertCharwise(segments, ["a", " ", "b"]);
  assertRanges(segments[1] as TextSegment, [
    range(node, 1, 2),
    range(node, 2, 3),
    range(node, 3, 4),
    range(node, 4, 5),
    range(node, 5, 6),
  ]);
});

test("跨节点空白在元素边界处仍压成单个空格", () => {
  const first = text("a ");
  const span = el("span", [text(" b ")]);
  const last = text(" c");
  const root = el("div", [first, span, last]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "a b c");
  const inner = span.children[0] as ReadNode;
  assertRanges(segments[1] as TextSegment, [range(first, 1, 2), range(inner, 0, 1)]);
  assertRanges(segments[3] as TextSegment, [range(inner, 2, 3), range(last, 0, 1)]);
});

test("块元素进入与退出各产生一次换行，相邻换行请求合并", () => {
  const first = text("a");
  const second = text("b");
  const root = el("div", [el("p", [first]), el("p", [second])]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "a\nb");
  assertCharwise(segments, ["a", null, "b"]);
});

test("嵌套块的连续换行请求只保留一个", () => {
  const leaf = text("x");
  const root = el("div", [el("p", [el("div", [leaf])])]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "x");
  assertCharwise(segments, ["x"]);
});

test("br 产生合成换行且来源为 null", () => {
  const before = text("a");
  const after = text("b");
  const root = el("div", [before, el("br", []), after]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "a\nb");
  assertCharwise(segments, ["a", null, "b"]);
});

test("换行两侧的空格被删除", () => {
  const left = text("a ");
  const right = text(" b");
  const root = el("div", [el("p", [left]), right]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "a\nb");
  assertCharwise(segments, ["a", null, "b"]);
});

test("被换行夹住的空格也会被删除", () => {
  const middle = text(" ");
  const root = el("div", [el("p", [text("a")]), middle, el("p", [text("b")])]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "a\nb");
  assertCharwise(segments, ["a", null, "b"]);
});

test("hidden 子树整体跳过，包括隐藏的 br 与块元素", () => {
  const visible = text("ok");
  const root = el("div", [
    el("p", [text("hidden text"), el("br", []), el("div", [text("deep")])], true),
    visible,
  ]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "ok");
  assertCharwise(segments, ["o", "k"]);
});

test("根节点 hidden 时输出空数组", () => {
  const root = el("div", [text("nope")], true);
  assert.deepEqual(extractTextSegments(root, BLOCK_TAGS), []);
});

test("script 与 style 子树被跳过", () => {
  const root = el("div", [
    el("script", [text("var x = 1;")]),
    text("a"),
    el("style", [text(".cls{display:none}")]),
    text("b"),
  ]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "ab");
  assertCharwise(segments, ["a", "b"]);
});

test("代理对按 Unicode 码点处理，UTF-16 区间覆盖整个代理对", () => {
  const node = text("a😀b");
  const segments = extractTextSegments(node, BLOCK_TAGS);

  assertCharwise(segments, ["a", "😀", "b"]);
  assertRanges(segments[0] as TextSegment, [range(node, 0, 1)]);
  assertRanges(segments[1] as TextSegment, [range(node, 1, 3)]);
  assertRanges(segments[2] as TextSegment, [range(node, 3, 4)]);
  assert.equal((segments[1] as TextSegment).codepoint.length, 2);
});

test("不可变输入：抽取过程不修改节点与文本", () => {
  const node = text("a  b");
  const root = el("p", [node, el("br", []), text("c")]);
  const snapshot = JSON.stringify(root);

  const deepFreeze = (value: ReadNode): void => {
    Object.freeze(value);
    for (const child of value.children) {
      deepFreeze(child);
    }
  };
  deepFreeze(root);

  const segments = extractTextSegments(root, BLOCK_TAGS);
  assert.equal(plainText(segments), "a b\nc");
  assert.equal(JSON.stringify(root), snapshot);
  assert.equal(node.data, "a  b");
});

test("空块元素与连续 br 的换行请求合并", () => {
  const root = el("div", [
    text("a"),
    el("p", []),
    el("br", []),
    el("br", []),
    text("b"),
  ]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "a\nb");
  assertCharwise(segments, ["a", null, "b"]);
});

test("整块被跳过时不产生任何换行", () => {
  const root = el("div", [text("a"), el("p", [text("x")], true), text("b")]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "ab");
  assertCharwise(segments, ["a", "b"]);
});

test("首尾换行删除后暴露的空格级联删除，内部空格保留", () => {
  const leading = text(" ");
  const middle = text("x  y");
  const trailing = text(" ");
  const root = el("p", [leading, middle, trailing]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "x y");
  assertCharwise(segments, ["x", " ", "y"]);
});

test("非块元素不产生换行，标签集合大小写敏感", () => {
  const root = el("DIV", [text("a"), el("P", [text("b")])]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "ab");
  assertCharwise(segments, ["a", "b"]);
});

test("整段参考结果：复杂树的区段序列与来源深度相等", () => {
  const first = text("Hello ");
  const second = text(" world ");
  const leaf = text("😀");
  const root = el("p", [first, second, el("br", []), leaf]);
  const segments = extractTextSegments(root, BLOCK_TAGS);

  assert.equal(plainText(segments), "Hello world\n😀");
  assert.deepEqual(segments, [
    { codepoint: "H", sources: [range(first, 0, 1)], isNewline: false },
    { codepoint: "e", sources: [range(first, 1, 2)], isNewline: false },
    { codepoint: "l", sources: [range(first, 2, 3)], isNewline: false },
    { codepoint: "l", sources: [range(first, 3, 4)], isNewline: false },
    { codepoint: "o", sources: [range(first, 4, 5)], isNewline: false },
    {
      codepoint: " ",
      sources: [range(first, 5, 6), range(second, 0, 1)],
      isNewline: false,
    },
    { codepoint: "w", sources: [range(second, 1, 2)], isNewline: false },
    { codepoint: "o", sources: [range(second, 2, 3)], isNewline: false },
    { codepoint: "r", sources: [range(second, 3, 4)], isNewline: false },
    { codepoint: "l", sources: [range(second, 4, 5)], isNewline: false },
    { codepoint: "d", sources: [range(second, 5, 6)], isNewline: false },
    { codepoint: "\n", sources: null, isNewline: true },
    { codepoint: "😀", sources: [range(leaf, 0, 2)], isNewline: false },
  ]);
});

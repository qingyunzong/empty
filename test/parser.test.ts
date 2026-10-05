import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, parse } from '../src/index.js';
import type { Node, ParseResult, RootNode } from '../src/index.js';

function serialize(node: RootNode | Node): string {
  if (node.type === 'text') return JSON.stringify(node.text);
  const inner = node.children.map(serialize).join(' ');
  const tag = node.type === 'root' ? 'root' : node.name;
  return inner ? `(${tag} ${inner})` : `(${tag})`;
}

function diagSummary(result: ParseResult): string[] {
  return result.diagnostics.map((d) => `${d.code}@${d.start}-${d.end}`);
}

function parseInChunks(input: string, size: number): ParseResult {
  const parser = new Parser();
  for (let i = 0; i < input.length; i += size) {
    parser.write(input.slice(i, i + size));
  }
  return parser.end();
}

/** 确定性伪随机（mulberry32），用于随机分块。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseRandomChunks(input: string, seed: number): ParseResult {
  const rand = mulberry32(seed);
  const parser = new Parser();
  let i = 0;
  while (i < input.length) {
    const size = 1 + Math.floor(rand() * 7);
    parser.write(input.slice(i, i + size));
    i += size;
  }
  return parser.end();
}

test('基本标签构建树', () => {
  const result = parse('<p>Hello <b>world</b>!</p>');
  assert.equal(serialize(result.root), '(root (p "Hello " (b "world") "!"))');
  assert.deepEqual(result.diagnostics, []);
});

test('p 内的新 p 隐式结束旧的 p', () => {
  const result = parse('<p>one<p>two</p>');
  assert.equal(serialize(result.root), '(root (p "one") (p "two"))');
  assert.deepEqual(result.diagnostics, []);
});

test('新 p 隐式结束旧 p 时，其中的内联元素记 implicit-close', () => {
  const result = parse('<p>a<b>b<p>c</p>');
  assert.equal(serialize(result.root), '(root (p "a" (b "b")) (p "c"))');
  assert.deepEqual(diagSummary(result), ['implicit-close@4-7']);
});

test('闭合不存在的标签被忽略并报告 unmatched-close', () => {
  const result = parse('a</b>c</i>');
  assert.equal(serialize(result.root), '(root "ac")');
  assert.deepEqual(diagSummary(result), ['unmatched-close@1-5', 'unmatched-close@6-10']);
});

test('闭合非栈顶元素时，其上的元素隐式关闭', () => {
  const result = parse('<b><i>x</b>');
  assert.equal(serialize(result.root), '(root (b (i "x")))');
  assert.deepEqual(diagSummary(result), ['implicit-close@3-6']);
});

test('不支持的标签被忽略并报告 unknown-tag', () => {
  const result = parse('<div>x</div>');
  assert.equal(serialize(result.root), '(root "x")');
  assert.deepEqual(diagSummary(result), ['unknown-tag@0-5', 'unknown-tag@6-12']);
});

test('br 是空元素，不需要闭合', () => {
  const result = parse('<p>a<br>b</p>');
  assert.equal(serialize(result.root), '(root (p "a" (br) "b"))');
  assert.deepEqual(result.diagnostics, []);
});

test('非空元素上的自闭合斜杠被忽略', () => {
  const result = parse('<p/>x');
  assert.equal(serialize(result.root), '(root (p "x"))');
  assert.deepEqual(diagSummary(result), ['unclosed-tag@0-4']);
});

test('实体解码保留原始偏移映射', () => {
  const result = parse('a &amp; b&#65;');
  const text = result.root.children[0]!;
  assert.equal(text.type, 'text');
  if (text.type !== 'text') return;
  assert.equal(text.text, 'a & bA');
  assert.deepEqual(text.segments, [
    { text: 'a ', start: 0, end: 2 },
    { text: '&', start: 2, end: 7 },
    { text: ' b', start: 7, end: 9 },
    { text: 'A', start: 9, end: 14 },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('支持全部命名实体与十六进制数字实体', () => {
  const result = parse('&lt;&gt;&amp;&quot;&apos;&#x3C;&#60;');
  const text = result.root.children[0]!;
  assert.equal(text.type, 'text');
  if (text.type !== 'text') return;
  assert.equal(text.text, '<>&"\'<<');
  assert.deepEqual(result.diagnostics, []);
});

test('未知实体保留字面文本并报告 unknown-entity', () => {
  const result = parse('&foo; &#0; &#xD800;');
  assert.equal(serialize(result.root), '(root "&foo; &#0; &#xD800;")');
  assert.deepEqual(diagSummary(result), [
    'unknown-entity@0-5',
    'unknown-entity@6-10',
    'unknown-entity@11-19',
  ]);
});

test('裸露的 < 和 & 按字面文本处理', () => {
  const result = parse('a < b & c');
  assert.equal(serialize(result.root), '(root "a < b & c")');
  assert.deepEqual(result.diagnostics, []);
});

test('输入末尾未终止的标签按字面文本处理并报告 malformed-tag', () => {
  const result = parse('x<b');
  assert.equal(serialize(result.root), '(root "x<b")');
  assert.deepEqual(diagSummary(result), ['malformed-tag@1-3']);
});

test('输入结束时未闭合的元素按弹栈顺序报告 unclosed-tag', () => {
  const result = parse('<p><b>x');
  assert.equal(serialize(result.root), '(root (p (b "x")))');
  assert.deepEqual(diagSummary(result), ['unclosed-tag@3-6', 'unclosed-tag@0-3']);
});

test('诊断按源码顺序报告', () => {
  const result = parse('</b><div>&foo;<p>x');
  assert.deepEqual(diagSummary(result), [
    'unmatched-close@0-4',
    'unknown-tag@4-9',
    'unknown-entity@9-14',
    'unclosed-tag@14-17',
  ]);
});

test('事件流独立于树规则，只描述词法内容', () => {
  const result = parse('<div>a</div>');
  assert.deepEqual(
    result.events.map((e) => e.type === 'text' ? `text:${e.text}` : `${e.type}:${e.name}`),
    ['open:div', 'text:a', 'close:div'],
  );
});

test('标签与实体跨块拆分结果一致', () => {
  const parser = new Parser();
  parser.write('<p').write('>a&am').write('p;<b').write('>b</b></p').write('>');
  const result = parser.end();
  assert.equal(serialize(result.root), '(root (p "a&" (b "b")))');
  assert.deepEqual(result.diagnostics, []);
});

test('增量分块与整体解析的事件流、树、诊断完全一致', () => {
  const corpus = [
    '',
    '<',
    '&',
    '&amp',
    'x<b',
    'a < b & c > d',
    '<p>Hello <b>world</b>!</p>',
    '<p>one<p>two</p>',
    '<p>a<b>b<p>c</p>',
    'a</b><div>x</div>&foo;&amp;&#x41;',
    '<p><b><i>deep</b></p>',
    '<br/><p/>tail',
    '<p>a&amp;b&lt;c&gt;d&quot;e&apos;f&#65;&#x42;</p>',
    '</b><div>&foo;<p>x',
  ];
  for (const input of corpus) {
    const whole = parse(input);
    for (const size of [1, 2, 3, 5, 8]) {
      assert.deepEqual(
        parseInChunks(input, size),
        whole,
        `chunk size ${size} for ${JSON.stringify(input)}`,
      );
    }
    for (const seed of [1, 42, 2024]) {
      assert.deepEqual(
        parseRandomChunks(input, seed),
        whole,
        `random chunks seed ${seed} for ${JSON.stringify(input)}`,
      );
    }
  }
});

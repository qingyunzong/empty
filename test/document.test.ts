import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, type DocNode } from '../src/index.js';
import { classifyLine } from '../src/parser.js';

interface NodeSnapshot {
  kind: string;
  level: number;
  text: string;
  range: [number, number, number, number];
  links: [string, string, string | null][];
  deps: number[];
}

function snapshot(doc: Document): NodeSnapshot[] {
  return doc.nodes.map((node) => ({
    kind: node.kind,
    level: node.level,
    text: node.text,
    range: [node.startLine, node.endLine, node.startOffset, node.endOffset],
    links: node.links.map((link) => [link.text, link.label, link.target]),
    deps: [...node.deps].sort((a, b) => a - b),
  }));
}

function assertConsistent(doc: Document): void {
  const full = Document.parse(doc.text);
  assert.deepEqual(snapshot(doc), snapshot(full), 'incremental result must equal full parse');
  for (const node of doc.nodes) {
    assert.equal(
      doc.text.slice(node.startOffset, node.endOffset),
      node.text,
      `node ${node.id} source range must slice back its text`,
    );
    for (let line = node.startLine; line < node.endLine; line++) {
      assert.notEqual(classifyLine(doc.lines[line]), 'definition');
      assert.notEqual(classifyLine(doc.lines[line]), 'blank');
    }
  }
}

test('parses headings, paragraphs and reference links; definition lines produce no nodes', () => {
  const doc = new Document(
    ['# Title', '', 'intro [site][a] text', '', '[a]: /first', '[a]: /second', '', 'tail'].join('\n'),
  );
  assert.equal(doc.nodes.length, 3);
  const [heading, para, tail] = doc.nodes;
  assert.equal(heading.kind, 'heading');
  assert.equal(heading.level, 1);
  assert.equal(heading.text, '# Title');
  assert.equal(para.kind, 'paragraph');
  assert.equal(para.text, 'intro [site][a] text');
  assert.equal(tail.text, 'tail');
  for (const node of doc.nodes) {
    for (let line = node.startLine; line < node.endLine; line++) {
      assert.notEqual(classifyLine(doc.lines[line]), 'definition');
    }
  }
});

test('a reference resolves to the last definition of its label', () => {
  const doc = new Document(
    ['see [site][a]', '', '[a]: /first', '[a]: /second'].join('\n'),
  );
  assert.equal(doc.nodes[0].links.length, 1);
  assert.equal(doc.nodes[0].links[0].target, '/second');
  assert.deepEqual([...doc.nodes[0].deps].sort((a, b) => a - b), [0, 3]);
});

test('removing the last definition falls back to the previous one', () => {
  const doc = new Document(
    ['see [site][a]', '', '[a]: /first', '[a]: /second'].join('\n'),
  );
  doc.applyEdit(3, 1, []);
  assert.equal(doc.nodes[0].links[0].target, '/first');
  assert.deepEqual([...doc.nodes[0].deps].sort((a, b) => a - b), [0, 2]);
  assertConsistent(doc);
});

test('editing a definition updates only the nodes that reference it', () => {
  const doc = new Document(
    [
      '# H',
      '',
      'p1 [x][a]',
      '',
      '[a]: /u1',
      '',
      'p2 plain',
      '',
      '[b]: /u2',
      '',
      'p3 [y][b] and [z][a]',
    ].join('\n'),
  );
  const before = new Map(doc.nodes.map((node) => [node.id, node]));
  const referencing = doc.nodes.filter((node) => node.links.some((l) => l.label === 'a'));
  const referencingIds = new Set(referencing.map((node) => node.id));

  const report = doc.applyEdit(4, 1, ['[a]: /u1-new']);

  assert.deepEqual([...report.updatedNodeIds].sort((a, b) => a - b), [...referencingIds].sort((a, b) => a - b));
  for (const node of doc.nodes) {
    const old = before.get(node.id);
    if (referencingIds.has(node.id)) {
      assert.notEqual(node, old, `node ${node.id} must be replaced`);
      assert.equal(node.version, old!.version + 1);
      assert.equal(node.links.find((l) => l.label === 'a')!.target, '/u1-new');
    } else {
      assert.equal(node, old, `node ${node.id} must keep its identity`);
      assert.equal(node.version, 1);
    }
  }
  assertConsistent(doc);
});

test('paragraphs merge and split across line edits', () => {
  const doc = new Document(['aaa', '', 'bbb'].join('\n'));
  assert.equal(doc.nodes.length, 2);
  doc.applyEdit(1, 1, []); // delete the blank line
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].text, 'aaa\nbbb');
  doc.applyEdit(1, 0, ['']); // insert a blank line back
  assert.equal(doc.nodes.length, 2);
  assertConsistent(doc);
});

test('source ranges stay accurate after insertions and deletions', () => {
  const doc = new Document(['# T', '', 'one [x][a]', '', '[a]: /u', '', 'two'].join('\n'));
  doc.applyEdit(0, 0, ['# New', '', 'lead']);
  assertConsistent(doc);
  doc.applyEdit(3, 2, []);
  assertConsistent(doc);
  for (const node of doc.nodes) {
    assert.equal(doc.text.slice(node.startOffset, node.endOffset), node.text);
  }
});

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

test('random line edits match a full reparse (text, ranges, links, dependency sets)', () => {
  const pool = [
    '# Alpha',
    '## Beta',
    'plain text line',
    'another text line',
    'see [one][r1] here',
    'and [two][r2] too',
    'mixed [a][r1] and [b][r2]',
    '[r1]: /u1',
    '[r2]: /u2',
    '[r1]: /u1-alt',
    '[r3]: /u3',
    '',
  ];
  const rnd = mulberry32(20261005);
  const pick = () => pool[Math.floor(rnd() * pool.length)];

  let totalEdits = 0;
  let totalUpdated = 0;
  for (let round = 0; round < 40; round++) {
    const initial: string[] = [];
    for (let i = 0; i < 30; i++) initial.push(pick());
    const doc = new Document(initial.join('\n'));
    assertConsistent(doc);
    for (let step = 0; step < 30; step++) {
      const startLine = Math.floor(rnd() * (doc.lines.length + 1));
      const maxDelete = Math.min(3, doc.lines.length - startLine);
      const deleteCount = Math.floor(rnd() * (maxDelete + 1));
      const inserted: string[] = [];
      const insertedCount = Math.floor(rnd() * 4);
      for (let k = 0; k < insertedCount; k++) inserted.push(pick());
      const report = doc.applyEdit(startLine, deleteCount, inserted);
      totalEdits++;
      totalUpdated += report.updatedNodeIds.length;
      assertConsistent(doc);
    }
  }
  console.error(
    `random differential: ${totalEdits} edits, avg updated nodes/edit = ${(totalUpdated / totalEdits).toFixed(2)}`,
  );
});

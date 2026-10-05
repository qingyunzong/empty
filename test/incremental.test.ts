import { test, describe } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import {
  IndentDocument,
  type EditResult,
  type LineError,
  type TreeNode,
} from '../src/indent-tree.js';

/** Structural projection without node ids (ids differ across documents). */
function stripIds(node: TreeNode): unknown {
  return {
    content: node.content,
    indent: node.indent,
    line: node.line,
    children: node.children.map(stripIds),
  };
}

function assertMatchesFullRebuild(doc: IndentDocument): void {
  const reference = IndentDocument.fullParse(doc.getText());
  deepEqual(stripIds(doc.toJSON()), stripIds(reference.tree), 'tree differs from full rebuild');
  deepEqual(doc.errors(), reference.errors, 'errors differ from full rebuild');
}

describe('incremental edits', () => {
  test('content edit keeps node ids and reports one updated node', () => {
    const doc = new IndentDocument(['a', '  b', '  c', 'd'].join('\n'));
    const idsBefore = doc.nodeList().map((n) => [n.content, n.id] as const);
    const result = doc.applyEdit(1, 1, ['  B']);
    equal(result.changes.added.length, 0);
    equal(result.changes.removed.length, 0);
    equal(result.changes.updated.length, 1);
    equal(result.changes.updated[0]!.content, 'B');
    // The updated node kept its id; every other node is untouched.
    const bId = idsBefore.find(([c]) => c === 'b')![1];
    equal(result.changes.updated[0]!.id, bId);
    for (const [content, id] of idsBefore) {
      if (content === 'b') continue;
      const still = doc.nodeList().find((n) => n.content === content)!;
      equal(still.id, id);
    }
    assertMatchesFullRebuild(doc);
  });

  test('insertion reports added nodes and preserves ids of shifted lines', () => {
    const doc = new IndentDocument(['a', '  b', 'c'].join('\n'));
    const idC = doc.nodeIdAtLine(2)!;
    const result = doc.applyEdit(2, 0, ['  b2', '    b3']);
    equal(result.changes.removed.length, 0);
    equal(result.changes.updated.length, 0);
    deepEqual(result.changes.added.map((n) => n.content), ['b2', 'b3']);
    // "c" shifted down by two lines but keeps its identity.
    equal(doc.nodeIdAtLine(4), idC);
    assertMatchesFullRebuild(doc);
  });

  test('deletion reports removed nodes only', () => {
    const doc = new IndentDocument(['a', '  b', '    x', '  c', 'd'].join('\n'));
    const idD = doc.nodeIdAtLine(4)!;
    const result = doc.applyEdit(2, 1, []);
    equal(result.changes.added.length, 0);
    equal(result.changes.updated.length, 0);
    deepEqual(result.changes.removed.map((n) => n.content), ['x']);
    equal(doc.nodeIdAtLine(3), idD);
    assertMatchesFullRebuild(doc);
  });

  test('indent change ripples depth updates through following lines', () => {
    const doc = new IndentDocument(['a', '  b', '    c', 'd'].join('\n'));
    // Deepening "b" past "c" makes "c" dedent onto "a": both nodes change.
    const result = doc.applyEdit(1, 1, ['      b']);
    const updated = result.changes.updated.map((n) => n.content).sort();
    deepEqual(updated, ['b', 'c']);
    const a = doc.nodeList().find((n) => n.content === 'a')!;
    const c = doc.nodeList().find((n) => n.content === 'c')!;
    equal(c.parentId, a.id);
    equal(c.depth, 1);
    assertMatchesFullRebuild(doc);
  });

  test('tab errors appear and disappear with edits', () => {
    const doc = new IndentDocument(['a', '  b'].join('\n'));
    let result = doc.applyEdit(2, 0, ['\tbad']);
    deepEqual(result.errors.map((e) => e.line), [2]);
    result = doc.applyEdit(2, 1, ['  good']);
    deepEqual(result.errors, []);
    assertMatchesFullRebuild(doc);
  });

  test('dedent errors are maintained incrementally', () => {
    const doc = new IndentDocument(['a', '    b', '  c', 'z'].join('\n'));
    deepEqual(doc.errors().map((e) => e.line), [2]);
    // Fix the dedent by outdenting "c" to a real level.
    const result = doc.applyEdit(2, 1, ['    c']);
    deepEqual(result.errors, []);
    assertMatchesFullRebuild(doc);
  });

  test('reparse range is limited to the affected region', () => {
    const lines = ['t0', '  x', 't1', '  y', '    y1', '  z', 't2', '  w'];
    const doc = new IndentDocument(lines.join('\n'));
    const result: EditResult = doc.applyEdit(4, 1, ['    Y1']);
    // Starts at the last unchanged line before the edit (the parser stack
    // is reconstructed there) and re-synchronizes before the next
    // top-level line "t2".
    equal(result.reparseRange.start, 3);
    ok(result.reparseRange.end <= 6, `reparse ended at ${result.reparseRange.end}`);
    assertMatchesFullRebuild(doc);
  });

  test('blank line insertion does not disturb the stack or ids', () => {
    const doc = new IndentDocument(['a', '  b', '  c'].join('\n'));
    const idC = doc.nodeIdAtLine(2)!;
    const result = doc.applyEdit(2, 0, ['', '   ']);
    equal(result.changes.added.length, 0);
    equal(result.changes.removed.length, 0);
    equal(result.changes.updated.length, 0);
    equal(doc.nodeIdAtLine(4), idC);
    assertMatchesFullRebuild(doc);
  });
});

describe('randomized differential test', () => {
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

  const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'node', 'leaf', 'x', 'y'];

  function randomLine(rng: () => number): string {
    const roll = rng();
    if (roll < 0.12) return rng() < 0.5 ? '' : '   ';
    const word = WORDS[Math.floor(rng() * WORDS.length)]!;
    if (roll < 0.18) {
      // Tab-indented line: must be rejected by the parser.
      return (rng() < 0.5 ? '\t' : '  \t') + word;
    }
    const indent = ' '.repeat(Math.floor(rng() * rng() * 9));
    return indent + word;
  }

  function randomLines(rng: () => number, max: number): string[] {
    const n = Math.floor(rng() * (max + 1));
    return Array.from({ length: n }, () => randomLine(rng));
  }

  test('random edits keep the incremental tree equal to a full rebuild', () => {
    const rng = mulberry32(20261006);
    let edits = 0;
    for (let round = 0; round < 200; round++) {
      const doc = new IndentDocument(randomLines(rng, 30).join('\n'));
      const editCount = 1 + Math.floor(rng() * 4);
      for (let e = 0; e < editCount; e++) {
        const lineCount = doc.lineCount;
        const start = Math.floor(rng() * (lineCount + 1));
        const deleteCount = Math.floor(rng() * Math.min(4, lineCount - start) + 0.999);
        const inserted = randomLines(rng, 4);

        // Record line->id mapping for id-preservation checks.
        const idsBefore = new Map<number, number>();
        for (let l = 0; l < lineCount; l++) {
          const id = doc.nodeIdAtLine(l);
          if (id !== null) idsBefore.set(l, id);
        }

        doc.applyEdit(start, deleteCount, inserted);
        edits++;

        // 1. Tree and errors are semantically identical to a full rebuild.
        assertMatchesFullRebuild(doc);

        // 2. Ids of untouched lines (before/after the edited range) survive.
        const delta = inserted.length - deleteCount;
        const editEnd = start + inserted.length;
        for (let l = 0; l < doc.lineCount; l++) {
          if (l >= start && l < editEnd) continue;
          const oldLine = l < start ? l : l - delta;
          const oldId = idsBefore.get(oldLine);
          if (oldId === undefined) continue;
          equal(doc.nodeIdAtLine(l), oldId, `id changed for untouched line ${l}`);
        }
      }
    }
    ok(edits >= 200, `expected many edits, ran ${edits}`);
  });

  test('error lines from random edits match the full rebuild exactly', () => {
    const rng = mulberry32(42);
    const seen = new Set<string>();
    for (let round = 0; round < 100; round++) {
      const doc = new IndentDocument(randomLines(rng, 20).join('\n'));
      for (let e = 0; e < 3; e++) {
        const start = Math.floor(rng() * (doc.lineCount + 1));
        const deleteCount = Math.floor(rng() * Math.min(3, doc.lineCount - start) + 0.999);
        const result = doc.applyEdit(start, deleteCount, randomLines(rng, 3));
        const reference = IndentDocument.fullParse(doc.getText());
        deepEqual(result.errors, reference.errors);
        for (const err of result.errors) seen.add(err.message.split(' ')[0]!);
      }
    }
    // Both error kinds were exercised.
    ok(seen.has('tab'), 'tab errors exercised');
    ok(seen.has('unindent'), 'unindent errors exercised');
  });
});

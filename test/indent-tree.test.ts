import { test, describe } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { IndentDocument, ROOT_ID, type TreeNode } from '../src/indent-tree.js';

function shape(node: TreeNode): unknown {
  return {
    content: node.content,
    indent: node.indent,
    children: node.children.map(shape),
  };
}

describe('full parse', () => {
  test('builds a nested tree from space indentation', () => {
    const doc = new IndentDocument(['root', '  child', '    grand', '  child2', 'sibling'].join('\n'));
    deepEqual(shape(doc.toJSON()), {
      content: '',
      indent: -1,
      children: [
        {
          content: 'root',
          indent: 0,
          children: [
            { content: 'child', indent: 2, children: [{ content: 'grand', indent: 4, children: [] }] },
            { content: 'child2', indent: 2, children: [] },
          ],
        },
        { content: 'sibling', indent: 0, children: [] },
      ],
    });
    equal(doc.errors().length, 0);
  });

  test('blank lines never change the indentation stack', () => {
    const text = ['a', '  b', '', '   ', '  c', 'd'].join('\n');
    const doc = new IndentDocument(text);
    // "c" must be a sibling of "b" (still under "a"), "d" a sibling of "a".
    deepEqual(shape(doc.toJSON()), {
      content: '',
      indent: -1,
      children: [
        {
          content: 'a',
          indent: 0,
          children: [
            { content: 'b', indent: 2, children: [] },
            { content: 'c', indent: 2, children: [] },
          ],
        },
        { content: 'd', indent: 0, children: [] },
      ],
    });
    // Blank lines own no nodes.
    equal(doc.nodeIdAtLine(2), null);
    equal(doc.nodeIdAtLine(3), null);
  });

  test('tab in indentation is rejected as an error line', () => {
    const doc = new IndentDocument(['a', '\tb', '  c'].join('\n'));
    const errors = doc.errors();
    equal(errors.length, 1);
    equal(errors[0]!.line, 1);
    ok(errors[0]!.message.includes('tab'));
    // The rejected line still participates (tabs count as zero indent).
    const b = doc.nodeList().find((n) => n.content === 'b')!;
    equal(b.indent, 0);
    equal(b.parentId, ROOT_ID);
  });

  test('whitespace-only line containing a tab is blank but still reported', () => {
    const doc = new IndentDocument(['a', '\t', '  b'].join('\n'));
    equal(doc.nodeIdAtLine(1), null);
    deepEqual(doc.errors().map((e) => e.line), [1]);
    // Stack unchanged by the blank tab line: b is a child of a.
    const b = doc.nodeList().find((n) => n.content === 'b')!;
    equal(b.depth, 1);
  });

  test('dedent to a non-existent level is an error line', () => {
    const doc = new IndentDocument(['a', '    b', '  c'].join('\n'));
    const errors = doc.errors();
    equal(errors.length, 1);
    equal(errors[0]!.line, 2);
    ok(errors[0]!.message.includes('unindent'));
    // Recovery: "c" attaches to the nearest shallower ancestor ("a").
    const c = doc.nodeList().find((n) => n.content === 'c')!;
    const a = doc.nodeList().find((n) => n.content === 'a')!;
    equal(c.parentId, a.id);
  });

  test('an indented first line attaches to the root without error', () => {
    const doc = new IndentDocument(['    a', '      b'].join('\n'));
    equal(doc.errors().length, 0);
    const a = doc.nodeList().find((n) => n.content === 'a')!;
    equal(a.depth, 0);
    equal(a.parentId, ROOT_ID);
  });
});

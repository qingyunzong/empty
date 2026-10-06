import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElementNode, compile, query, referenceQuery, referenceMatches } from '../src/index.js';
import { rng, randomTree, randomSelector } from './helpers.js';

function tree(): { root: ElementNode; byTag: (tag: string) => ElementNode[] } {
  // root(div)
  // ├── div[data-x="1"]
  // │   ├── span
  // │   └── p[data-y="2"]
  // │       └── span[data-x="1"]
  // └── section
  //     └── span
  const root = new ElementNode('div');
  const a = new ElementNode('div', { 'data-x': '1' });
  const aSpan = new ElementNode('span');
  const aP = new ElementNode('p', { 'data-y': '2' });
  const aPSpan = new ElementNode('span', { 'data-x': '1' });
  const b = new ElementNode('section');
  const bSpan = new ElementNode('span');
  for (const [parent, child] of [
    [root, a],
    [a, aSpan],
    [a, aP],
    [aP, aPSpan],
    [root, b],
    [b, bSpan],
  ] as const) {
    parent.children.push(child);
    child.parent = parent;
  }
  const byTag = (tag: string) =>
    [...root.selfAndDescendants()].filter((n) => n.tag === tag);
  return { root, byTag };
}

test('matches tags in document order', () => {
  const { root, byTag } = tree();
  assert.deepEqual(query(root, 'span'), byTag('span'));
});

test('matches attribute equality', () => {
  const { root } = tree();
  const result = query(root, '[data-x="1"]');
  assert.equal(result.length, 2);
  assert.equal(result[0]!.tag, 'div');
  assert.equal(result[1]!.tag, 'span');
});

test('child combinator only matches direct children', () => {
  const { root } = tree();
  assert.equal(query(root, 'div > span').length, 1); // aSpan only
  assert.equal(query(root, 'div span').length, 3);
  assert.equal(query(root, 'p > span[data-x="1"]').length, 1);
});

test('comma unions are deduplicated and stay in document order', () => {
  const { root, byTag } = tree();
  const result = query(root, 'span, [data-x="1"], span');
  const expected = [...root.selfAndDescendants()].filter(
    (n) => n.tag === 'span' || n.getAttribute('data-x') === '1',
  );
  assert.deepEqual(result, expected);
  assert.equal(new Set(result).size, result.length);
  void byTag;
});

test('scope root cannot be crossed by descendant or child combinators', () => {
  const { root } = tree();
  const inner = root.children[0]!; // div[data-x="1"]
  // 'div span' scoped at inner div: the root div is outside the scope,
  // so only spans inside inner can match via inner itself.
  assert.deepEqual(query(inner, 'div span'), query(inner, 'span'));
  // Scoped at the inner div, 'div > span' matches its direct span child...
  assert.equal(query(inner, 'div > span').length, 1);
  // ...but a selector needing an ancestor above the scope root matches nothing.
  assert.equal(query(inner, 'section span').length, 0);
  assert.equal(query(inner, 'div > div span').length, 0);
  // The scope root itself may still match a simple selector.
  assert.deepEqual(query(inner, 'div'), [inner]);
});

test('plans are reusable across roots', () => {
  const first = tree();
  const second = tree();
  const plan = compile('div[data-x="1"] > p span');
  assert.equal(plan.query(first.root).length, 1);
  assert.equal(plan.query(second.root).length, 1);
  assert.equal(plan.source, 'div[data-x="1"] > p span');
});

test('compiled plan agrees with naive recursive reference on random inputs', () => {
  const rand = rng(20261007);
  for (let trial = 0; trial < 300; trial++) {
    const root = randomTree(rand);
    const selector = randomSelector(rand);
    const expected = referenceQuery(root, selector);
    const actual = compile(selector).query(root);
    assert.deepEqual(
      actual,
      expected,
      `mismatch for selector "${selector}" on trial ${trial}`,
    );
    // Per-node predicate must agree too.
    for (const node of root.selfAndDescendants()) {
      assert.equal(
        compile(selector).matches(node, root),
        referenceMatches(selector, node, root),
      );
    }
  }
});

test('scoped subqueries agree with the reference on random inputs', () => {
  const rand = rng(42);
  for (let trial = 0; trial < 200; trial++) {
    const root = randomTree(rand);
    const nodes = [...root.selfAndDescendants()];
    const scope = nodes[Math.floor(rand() * nodes.length)]!;
    const selector = randomSelector(rand);
    assert.deepEqual(compile(selector).query(scope), referenceQuery(scope, selector));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ElementNode,
  Engine,
  LiveQuery,
  compile,
  type Diff,
} from '../src/index.js';
import { rng, randomTree } from './helpers.js';

function build(engine: Engine): { root: ElementNode; inner: ElementNode; deep: ElementNode } {
  // root(div) > inner(div) > deep(span)
  const root = new ElementNode('div');
  const inner = new ElementNode('div');
  const deep = new ElementNode('span');
  engine.appendChild(root, inner);
  engine.appendChild(inner, deep);
  engine.flush();
  return { root, inner, deep };
}

test('initial snapshot matches a full query', () => {
  const engine = new Engine();
  const { root } = build(engine);
  const live = new LiveQuery(engine, root, compile('div'));
  assert.deepEqual(live.snapshot().nodes, [...root.selfAndDescendants()].filter((n) => n.tag === 'div'));
  assert.equal(live.snapshot().version, 0);
  live.verify();
});

test('attribute change on an ancestor invalidates deep descendant matches', () => {
  const engine = new Engine();
  const { root, inner, deep } = build(engine);
  const live = new LiveQuery(engine, root, compile('div[data-x="1"] span'));
  const diffs: Diff[] = [];
  live.onDiff((diff) => diffs.push(diff));

  assert.equal(live.snapshot().nodes.length, 0);

  engine.setAttribute(inner, 'data-x', '1');
  engine.flush();
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0]!.added, [deep]);
  assert.equal(diffs[0]!.removed.length, 0);
  live.verify();

  engine.removeAttribute(inner, 'data-x');
  engine.flush();
  assert.equal(diffs.length, 2);
  assert.deepEqual(diffs[1]!.removed, [deep]);
  assert.equal(diffs[1]!.added.length, 0);
  live.verify();
});

test('child combinator diffs track reparenting-free structural changes', () => {
  const engine = new Engine();
  const { root, deep } = build(engine);
  const live = new LiveQuery(engine, root, compile('div > span'));
  const diffs: Diff[] = [];
  live.onDiff((diff) => diffs.push(diff));

  // deep (span under inner div) already matches; a direct child of root too.
  const direct = new ElementNode('span');
  engine.appendChild(root, direct);
  engine.flush();
  assert.deepEqual(diffs[0]!.added, [direct]);

  // A span nested under a span does not match 'div > span'.
  const nested = new ElementNode('span');
  engine.appendChild(deep, nested);
  engine.flush();
  assert.equal(diffs.length, 1, 'non-matching append produces no diff');
  live.verify();

  engine.removeChild(direct);
  engine.flush();
  assert.equal(diffs.length, 2);
  assert.deepEqual(diffs[1]!.removed, [direct]);
  live.verify();
});

test('removing a subtree removes all its matched nodes', () => {
  const engine = new Engine();
  const { root, inner, deep } = build(engine);
  engine.setAttribute(deep, 'data-x', '1');
  engine.flush();
  const live = new LiveQuery(engine, root, compile('div, [data-x="1"]'));
  const diffs: Diff[] = [];
  live.onDiff((diff) => diffs.push(diff));
  assert.equal(live.snapshot().nodes.length, 3);

  engine.removeChild(inner);
  engine.flush();
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0]!.removed, [inner, deep]);
  assert.deepEqual(live.snapshot().nodes, [root]);
  live.verify();
});

test('old snapshots are preserved and never mutated', () => {
  const engine = new Engine();
  const { root, inner } = build(engine);
  const live = new LiveQuery(engine, root, compile('div'));
  const v0 = live.snapshot();
  assert.equal(v0.nodes.length, 2);

  const extra = new ElementNode('div');
  engine.appendChild(inner, extra);
  engine.flush();

  const v1 = live.snapshot();
  assert.equal(v1.version, 1);
  assert.equal(v1.nodes.length, 3);
  assert.equal(v0.nodes.length, 2, 'old snapshot unchanged');
  assert.ok(Object.isFrozen(v0.nodes));
  assert.deepEqual(live.history(), [v0, v1]);
  live.verify();
});

test('reentrant mutations from diff listeners are delivered in the next batch', () => {
  const engine = new Engine();
  const { root, inner, deep } = build(engine);
  const live = new LiveQuery(engine, root, compile('[data-x="1"]'));
  const batches: Diff[] = [];

  live.onDiff((diff) => {
    batches.push(diff);
    if (batches.length === 1) {
      // Reentrant mutation: must not appear in this batch's snapshot.
      engine.setAttribute(deep, 'data-x', '1');
    }
  });

  engine.setAttribute(inner, 'data-x', '1');
  engine.flush();

  assert.equal(batches.length, 2, 'reentrant mutation produced a second batch');
  assert.deepEqual(batches[0]!.added, [inner]);
  assert.deepEqual(batches[1]!.added, [deep]);
  assert.equal(batches[0]!.snapshot.version, 1);
  assert.equal(batches[1]!.snapshot.version, 2);
  live.verify();
});

test('mutations flush asynchronously via microtasks', async () => {
  const engine = new Engine();
  const { root, inner } = build(engine);
  const live = new LiveQuery(engine, root, compile('[data-x="1"]'));
  const diffs: Diff[] = [];
  live.onDiff((diff) => diffs.push(diff));

  engine.setAttribute(inner, 'data-x', '1');
  assert.equal(diffs.length, 0, 'no synchronous delivery');
  await engine.settled();
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0]!.added, [inner]);
  live.verify();
});

test('incremental state matches the reference after random mutation sequences', () => {
  const rand = rng(1337);
  for (let trial = 0; trial < 30; trial++) {
    const engine = new Engine();
    const root = randomTree(rand, 3, 3);
    const live = new LiveQuery(engine, root, compile('div[data-x="1"] span, [data-y="2"]'));
    live.onDiff(() => live.verify());

    const pool = [...root.selfAndDescendants()];
    for (let step = 0; step < 40; step++) {
      const action = rand();
      const node = pool[Math.floor(rand() * pool.length)]!;
      if (action < 0.4) {
        engine.setAttribute(node, rand() < 0.5 ? 'data-x' : 'data-y', rand() < 0.5 ? '1' : '2');
      } else if (action < 0.6) {
        engine.removeAttribute(node, rand() < 0.5 ? 'data-x' : 'data-y');
      } else if (action < 0.8) {
        const child = randomTree(rand, 1, 2);
        engine.appendChild(node, child);
        pool.push(...child.selfAndDescendants());
      } else if (node !== root && node.parent) {
        engine.removeChild(node);
        const detached = new Set(node.selfAndDescendants());
        for (let i = pool.length - 1; i >= 0; i--) {
          if (detached.has(pool[i]!)) pool.splice(i, 1);
        }
      }
    }
    engine.flush();
    live.verify();
  }
});

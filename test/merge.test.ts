import assert from 'node:assert/strict';
import test from 'node:test';
import { PagedTextModel } from '../src/paged';
import { Op, Selection, Site, mergeOps, replay } from '../src/model';
import { buildDoc } from './helpers';

/**
 * Scenario: base document "hello world", two branches diverge.
 *  - Branch A deletes 'o'(4) and 'w'(6), and appends '!' after 'd'(10).
 *  - Branch B inserts 'X' and 'Y' after 'h'(0), and deletes 'd'(10).
 * A selection made on branch B anchors on characters that get deleted,
 * exercising anchor gravitation after the merge.
 */
function scenario() {
  const base = new Site('base');
  const { ops: baseOps, ids } = buildDoc(base, 'hello world');

  const siteA = new Site('A');
  const branchA: Op[] = [
    siteA.delete(ids[4]!), // 'o'
    siteA.delete(ids[6]!), // 'w'
    siteA.insert(ids[10]!, '!'),
  ];

  const siteB = new Site('B');
  const branchB: Op[] = [
    siteB.insert(ids[0]!, 'X'),
    siteB.insert(ids[0]!, 'Y'),
    siteB.delete(ids[10]!), // 'd'
  ];

  // Selection from branch B: anchor before 'o' (deleted by A),
  // head before 'd' (deleted by B itself).
  const selection: Selection = { anchor: ids[4]!, head: ids[10]! };

  return { baseOps, branchA, branchB, selection, ids };
}

test('merging two branches converges regardless of replay order', () => {
  const { baseOps, branchA, branchB } = scenario();

  const merged = mergeOps(baseOps, branchA, branchB);
  const expected = 'hXYell orl!';

  assert.equal(replay(merged).text(), expected);
  assert.equal(replay([...branchB, ...baseOps, ...branchA]).text(), expected);
  assert.equal(replay([...merged].reverse()).text(), expected);
});

test('selection after merge matches between paged and unpaginated models', () => {
  const { baseOps, branchA, branchB, selection } = scenario();
  const merged = mergeOps(baseOps, branchA, branchB);

  const flat = replay(merged);
  const paged = new PagedTextModel(3); // tiny pages force cross-page moves
  paged.applyAll(merged);

  assert.equal(flat.text(), 'hXYell orl!');
  assert.equal(paged.text(), flat.text());
  assert.ok(paged.pageCount > 1);

  // Anchor was on deleted 'o': gravitates right to the surviving space
  // (live index 6). Head was on deleted 'd': gravitates right to '!' (10).
  const expected = { start: 6, end: 10 };
  assert.deepEqual(flat.resolveSelection(selection), expected);
  assert.deepEqual(paged.resolveSelection(selection), expected);
  assert.equal(flat.text().slice(expected.start, expected.end), ' orl');
});

test('selection anchored at a deleted tail character resolves to end in both models', () => {
  const base = new Site('base');
  const { ops: baseOps, ids } = buildDoc(base, 'abcdef');
  const siteA = new Site('A');
  const siteB = new Site('B');
  // Branch A deletes the tail 'def'; branch B inserts 'g' after 'c'.
  const branchA: Op[] = [siteA.delete(ids[3]!), siteA.delete(ids[4]!), siteA.delete(ids[5]!)];
  const branchB: Op[] = [siteB.insert(ids[2]!, 'g')];
  const merged = mergeOps(baseOps, branchA, branchB);

  const selection: Selection = { anchor: ids[1]!, head: ids[5]! }; // head on deleted 'f'

  const flat = replay(merged);
  const paged = new PagedTextModel(2);
  paged.applyAll(merged);

  assert.equal(flat.text(), 'abcg');
  assert.equal(paged.text(), flat.text());
  const expected = { start: 1, end: 4 }; // head falls off the right edge -> end of doc
  assert.deepEqual(flat.resolveSelection(selection), expected);
  assert.deepEqual(paged.resolveSelection(selection), expected);
});

test('cross-branch merge applied incrementally converges with full replay', () => {
  const { baseOps, branchA, branchB } = scenario();

  // Replica 1: base + A, then receives B.
  const r1 = replay(mergeOps(baseOps, branchA));
  r1.applyAll(branchB);
  // Replica 2: base + B, then receives A.
  const r2 = replay(mergeOps(baseOps, branchB));
  r2.applyAll(branchA);
  // Replica 3: paged, interleaved arrival.
  const r3 = new PagedTextModel(4);
  r3.applyAll(mergeOps(baseOps, branchA, branchB));

  assert.equal(r1.text(), r2.text());
  assert.equal(r3.text(), r1.text());
});

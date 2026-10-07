import assert from 'node:assert/strict';
import test from 'node:test';
import { Site, replay } from '../src/model';
import { buildDoc } from './helpers';

test('deleted anchor gravitates to the nearest surviving character on its right', () => {
  const site = new Site('s1');
  const { ops, ids } = buildDoc(site, 'abcde');
  const model = replay(ops);

  // Cursor anchored before 'c'.
  assert.equal(model.resolveCursor(ids[2]!), 2);

  // Delete 'c': anchor lands before 'd' (gap index 2 in "abde").
  model.apply(site.delete(ids[2]!));
  assert.equal(model.text(), 'abde');
  assert.equal(model.resolveCursor(ids[2]!), 2);

  // Delete 'd' as well: anchor lands before 'e' (gap index 2 in "abe").
  model.apply(site.delete(ids[3]!));
  assert.equal(model.text(), 'abe');
  assert.equal(model.resolveCursor(ids[2]!), 2);
  assert.equal(model.liveIds()[2], ids[4]);
});

test('deleted anchor with no survivor to its right lands at end of document', () => {
  const site = new Site('s1');
  const { ops, ids } = buildDoc(site, 'abcde');
  const model = replay(ops);

  model.apply(site.delete(ids[4]!)); // delete 'e'
  assert.equal(model.resolveCursor(ids[4]!), 4);

  model.apply(site.delete(ids[3]!)); // delete 'd'
  assert.equal(model.resolveCursor(ids[3]!), 3);
  assert.equal(model.resolveCursor(ids[4]!), 3);

  // Delete everything: every anchor resolves to 0 (also the end).
  model.apply(site.delete(ids[0]!));
  model.apply(site.delete(ids[1]!));
  model.apply(site.delete(ids[2]!));
  assert.equal(model.text(), '');
  assert.equal(model.resolveCursor(ids[2]!), 0);
});

test('null cursor always resolves to the end of the document', () => {
  const site = new Site('s1');
  const { ops, ids } = buildDoc(site, 'abc');
  const model = replay(ops);
  assert.equal(model.resolveCursor(null), 3);
  model.apply(site.insert(ids[2]!, 'd'));
  assert.equal(model.resolveCursor(null), 4);
});

test('concurrent inserts at the same position are ordered by op id', () => {
  const siteA = new Site('a');
  const siteB = new Site('b');
  const { ops: base, ids } = buildDoc(siteA, 'a');

  // Both sites insert at the same position (afterId = id of 'a').
  const fromB1 = siteB.insert(ids[0]!, '1');
  const fromB2 = siteB.insert(ids[0]!, '2');
  const fromA = siteA.insert(ids[0]!, 'x');

  // Children of 'a' sort by op id: a#2 ('x') < b#1 ('1') < b#2 ('2').
  const expected = 'ax12';

  // Application order must not matter.
  assert.equal(replay([...base, fromB2, fromA, fromB1]).text(), expected);
  assert.equal(replay([...base, fromA, fromB1, fromB2]).text(), expected);
  assert.equal(replay([...base, fromB1, fromB2, fromA]).text(), expected);
});

test('insert after a character nests under it regardless of arrival order', () => {
  const siteA = new Site('a');
  const siteB = new Site('b');
  const { ops: base, ids } = buildDoc(siteA, 'a');

  // B inserts 'x' after 'a'; A then inserts 'y' after 'x'.
  const bx = siteB.insert(ids[0]!, 'x');
  const ay = siteA.insert(bx.id, 'y');
  assert.equal(replay([...base, bx, ay]).text(), 'axy');
  // Replaying in a different arrival order yields the same text.
  assert.equal(replay([bx, ay, ...base].reverse()).text(), 'axy');
});

test('operations are idempotent under replay', () => {
  const site = new Site('s1');
  const { ops, ids } = buildDoc(site, 'abc');
  const del = site.delete(ids[1]!);
  const model = replay([...ops, del, ...ops, del]);
  assert.equal(model.text(), 'ac');
});

test('selection resolves to a normalized range', () => {
  const site = new Site('s1');
  const { ops, ids } = buildDoc(site, 'abcdef');
  const model = replay(ops);
  // Reversed selection (anchor after head) normalizes.
  const range = model.resolveSelection({ anchor: ids[4]!, head: ids[1]! });
  assert.deepEqual(range, { start: 1, end: 4 });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { PagedTextModel } from '../src/paged';
import { Site } from '../src/model';
import { buildDoc } from './helpers';

test('moving a character across pages never changes its id or node identity', () => {
  const site = new Site('s1');
  const { ops, ids } = buildDoc(site, 'abcdefgh');
  const paged = new PagedTextModel(3);
  paged.applyAll(ops);

  // 'h' starts on the last page (page 2 with pageSize 3).
  const target = ids[7]!;
  const before = paged.model.get(target);
  assert.equal(paged.locate(target)!.page, 2);

  // Delete the first three characters, pulling 'h' forward across a page.
  paged.applyAll([site.delete(ids[0]!), site.delete(ids[1]!), site.delete(ids[2]!)]);

  assert.equal(paged.text(), 'defgh');
  // 'h' moved from page 2 to page 1, but id and node object are untouched.
  assert.equal(paged.locate(target)!.page, 1);
  assert.equal(paged.model.get(target), before);
  assert.equal(paged.model.get(target)!.id, target);
});

test('pages tile the document in order and respect page size', () => {
  const site = new Site('s1');
  const { ops } = buildDoc(site, 'abcdefghij');
  const paged = new PagedTextModel(4);
  paged.applyAll(ops);

  assert.equal(paged.pageCount, 3);
  assert.equal(paged.pageText(0), 'abcd');
  assert.equal(paged.pageText(1), 'efgh');
  assert.equal(paged.pageText(2), 'ij');
  assert.equal(
    Array.from({ length: paged.pageCount }, (_, i) => paged.pageText(i)).join(''),
    paged.text(),
  );
});

test('deletes shrink pages without disturbing surviving ids', () => {
  const site = new Site('s1');
  const { ops, ids } = buildDoc(site, 'abcdef');
  const paged = new PagedTextModel(2);
  paged.applyAll(ops);
  assert.equal(paged.pageCount, 3);

  paged.apply(site.delete(ids[0]!));
  paged.apply(site.delete(ids[1]!));
  assert.equal(paged.text(), 'cdef');
  assert.equal(paged.pageCount, 2);
  assert.equal(paged.locate(ids[2]!)!.page, 0);
  assert.equal(paged.locate(ids[5]!)!.page, 1);
});

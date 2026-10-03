import test from 'node:test';
import assert from 'node:assert/strict';
import { PositionalIndex, tokenize } from '../src/index.js';

test('tokenize: CJK chars are single tokens, latin runs lowercase', () => {
  assert.deepEqual(tokenize('换模 后 延迟'), ['换', '模', '后', '延', '迟']);
  assert.deepEqual(tokenize('Setup DONE, v2'), ['setup', 'done', 'v2']);
  assert.deepEqual(tokenize('换模后delay2小时'), ['换', '模', '后', 'delay2', '小', '时']);
});

test('phrase query matches consecutive tokens only', () => {
  const idx = new PositionalIndex();
  idx.addDocument(1, '换模 后 延迟 两 小时');
  idx.addDocument(2, '换模 后 不 延迟');
  idx.addDocument(3, '正常 生产 无 延迟');
  assert.deepEqual(idx.phrase('换模 后 延迟'), [{ docId: 1, positions: [0] }]);
  assert.deepEqual(idx.phrase('延迟'), [{ docId: 1, positions: [3] }, { docId: 2, positions: [4] }, { docId: 3, positions: [5] }]);
  assert.deepEqual(idx.phrase('换模 延迟'), []); // gap -> no phrase match
});

test('near query respects distance k', () => {
  const idx = new PositionalIndex();
  idx.addDocument(1, '换模 后 延迟');       // 换@0 延@3
  idx.addDocument(2, '换模 后 不 再 延迟'); // 换@0 延@5
  assert.deepEqual(idx.near('换', '延', 3).map((r) => r.docId), [1]);
  assert.deepEqual(idx.near('换', '延', 5).map((r) => r.docId), [1, 2]);
  assert.deepEqual(idx.near('换', '延', 2), []);
});

test('time-window filter uses doc meta interval overlap', () => {
  const idx = new PositionalIndex();
  idx.addDocument(1, '换模 后 延迟', { start: 0, end: 5 });
  idx.addDocument(2, '换模 后 延迟', { start: 10, end: 20 });
  assert.deepEqual(idx.phrase('换模 后 延迟', { window: { start: 4, end: 10 } }).map((r) => r.docId), [1]);
  assert.deepEqual(idx.phrase('换模 后 延迟', { window: { start: 5, end: 10 } }), []); // half-open, no touch
  assert.deepEqual(idx.phrase('换模 后 延迟', { window: { start: 0, end: 30 } }).map((r) => r.docId), [1, 2]);
});

test('term postings survive an encode/decode roundtrip', () => {
  const idx = new PositionalIndex();
  idx.addDocument(1, 'a b a c a');
  idx.addDocument(5, 'a a');
  idx.addDocument(9, 'b a');
  const decoded = PositionalIndex.decodeTerm(idx.encodeTerm('a'));
  assert.deepEqual(decoded.get(1), [0, 2, 4]);
  assert.deepEqual(decoded.get(5), [0, 1]);
  assert.deepEqual(decoded.get(9), [1]);
  assert.equal(idx.encodeTerm('missing').length, 1); // docCount=0
});

test('deleting a document removes it from the compressed index (no false positives)', () => {
  const idx = new PositionalIndex();
  idx.addDocument(1, '换模 后 延迟 两 小时');
  idx.addDocument(2, '换模 后 正常');
  assert.equal(idx.phrase('换模 后 延迟').length, 1);
  assert.ok(idx.removeDocument(1));
  assert.deepEqual(idx.phrase('换模 后 延迟'), []);
  // compressed postings for shared terms no longer contain doc 1
  for (const term of ['换', '模', '后', '延', '迟']) {
    assert.ok(!PositionalIndex.decodeTerm(idx.encodeTerm(term)).has(1));
  }
  // surviving doc still matches its own phrases
  assert.deepEqual(idx.phrase('换模 后 正常'), [{ docId: 2, positions: [0] }]);
  assert.ok(!idx.removeDocument(1)); // already gone
});

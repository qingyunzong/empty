import test from 'node:test';
import assert from 'node:assert/strict';
import { AlarmIndex } from '../src/index.js';

const fill = (n) => Array.from({ length: n }, (_, i) => `f${i}`).join(' ');

function boundaryIndex() {
  const idx = new AlarmIndex();
  idx.addDocument('k0-hit', '原因码 处理码'); // 0 words between
  idx.addDocument('k0-miss', `原因码 ${fill(1)} 处理码`); // 1 word between
  idx.addDocument('k4-hit', `原因码 ${fill(4)} 处理码`); // exactly 4 words between
  idx.addDocument('k4-miss', `原因码 ${fill(5)} 处理码`); // exactly 5 words between
  idx.addDocument('k5-miss', `原因码 ${fill(6)} 处理码`); // exactly 6 words between
  return idx;
}

const ids = (rs) => rs.map((r) => r.docId).sort();

test('boundary k=0: only adjacent cause/handling codes hit', () => {
  const idx = boundaryIndex();
  assert.deepEqual(ids(idx.query('原因码 NEAR/0 处理码')), ['k0-hit']);
});

test('boundary k=4: gap of 4 hits, gap of 5 misses', () => {
  const idx = boundaryIndex();
  assert.deepEqual(
    ids(idx.query('原因码 NEAR/4 处理码')),
    ['k0-hit', 'k0-miss', 'k4-hit'],
  );
});

test('boundary k=5: gap of 5 hits, gap of 6 misses', () => {
  const idx = boundaryIndex();
  assert.deepEqual(
    ids(idx.query('原因码 NEAR/5 处理码')),
    ['k0-hit', 'k0-miss', 'k4-hit', 'k4-miss'],
  );
  assert.ok(!ids(idx.query('原因码 NEAR/5 处理码')).includes('k5-miss'));
});

test('phrase "泵 气蚀" hits within a paragraph only', () => {
  const idx = new AlarmIndex();
  idx.addDocument('within', '泵 气蚀 处理');
  idx.addDocument('cross', '泵\n\n气蚀 处理'); // adjacent positions, different paragraphs
  idx.addDocument('split', '泵 的 气蚀');
  const rs = idx.query('"泵 气蚀"');
  assert.deepEqual(ids(rs), ['within']);
  assert.equal(rs[0].hits, 1);
  assert.equal(rs[0].minSpan, 2);
});

test('cross-paragraph proximity does not hit', () => {
  const idx = new AlarmIndex();
  idx.addDocument('cross', '原因码 a b\n\nc 处理码');
  assert.deepEqual(idx.query('原因码 NEAR/4 处理码'), []);
});

test('empty term and punctuation-only queries raise E_TOKEN', () => {
  const idx = new AlarmIndex();
  idx.addDocument('d', '泵 气蚀');
  for (const q of ['', '   ', '""', '！！！']) {
    assert.throws(() => idx.query(q), (err) => err.code === 'E_TOKEN');
  }
  assert.throws(() => idx.query('原因码 NEAR/2 处理码 额外'), (err) => err.code === 'E_SPAN');
});

test('invalid span limits raise E_SPAN', () => {
  const idx = new AlarmIndex();
  idx.addDocument('d', '原因码 处理码');
  for (const q of ['原因码 NEAR/-1 处理码', '原因码 NEAR/abc 处理码', '原因码 NEAR/ 处理码', '原因码 NEAR/2.5 处理码']) {
    assert.throws(() => idx.query(q), (err) => err.code === 'E_SPAN');
  }
});

test('ranking: hits desc, then min span asc, then docID asc (stable ties)', () => {
  const idx = new AlarmIndex();
  idx.addDocument('n1', '原因码 处理码 x 原因码 处理码'); // 4 pairs (incl. reverse), min span 2
  idx.addDocument('n2', '原因码 f f 处理码'); // 1 pair, span 4
  idx.addDocument('n3', '原因码 处理码'); // 1 pair, span 2
  idx.addDocument('n4', '原因码 处理码'); // 1 pair, span 2 (tie with n3 -> docID order)
  const rs = idx.query('原因码 NEAR/4 处理码');
  assert.deepEqual(
    rs.map((r) => [r.docId, r.hits, r.minSpan]),
    [['n1', 4, 2], ['n3', 1, 2], ['n4', 1, 2], ['n2', 1, 4]],
  );
  // repeated queries return identical ordering (stability)
  const again = idx.query('原因码 NEAR/4 处理码').map((r) => r.docId);
  assert.deepEqual(again, ['n1', 'n3', 'n4', 'n2']);
});

test('tombstoned docs are filtered before and after compact', () => {
  const idx = new AlarmIndex();
  idx.addDocument('old', '泵 气蚀 原因码 处理码');
  idx.addDocument('new', '泵 气蚀 正常');
  idx.deleteDocument('old');
  assert.deepEqual(ids(idx.query('"泵 气蚀"')), ['new']); // tombstone filters
  idx.compact();
  assert.deepEqual(ids(idx.query('"泵 气蚀"')), ['new']); // still gone
  assert.equal(idx.deletionCount, 1);
});

test('unknown terms yield empty results, not errors', () => {
  const idx = new AlarmIndex();
  idx.addDocument('d', '泵 气蚀');
  assert.deepEqual(idx.query('不存在的词'), []);
  assert.deepEqual(idx.query('泵 NEAR/3 不存在'), []);
  assert.deepEqual(idx.query('"泵 不存在"'), []);
});

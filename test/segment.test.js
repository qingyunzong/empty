import test from 'node:test';
import assert from 'node:assert/strict';

const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code);
import { encodeSegment, decodeSegment, findPhrase, tokenize } from '../src/segment.js';

test('segment encode/decode roundtrip with position index', () => {
  const text = '产品 复验 合格 准予 出厂 复验 合格';
  const buf = encodeSegment({ id: 'c1', epoch: 3, text });
  const seg = decodeSegment(buf);
  assert.equal(seg.id, 'c1');
  assert.equal(seg.epoch, 3);
  assert.equal(seg.text, text);
  assert.deepEqual(seg.index.get('复验'), [1, 5]);
  assert.deepEqual(findPhrase(seg.index, '复验 合格'), [1, 5]);
  assert.deepEqual(findPhrase(seg.index, '合格 复验'), []);
});

test('truncated segment -> E_TORN', () => {
  const buf = encodeSegment({ id: 'c1', epoch: 1, text: '复验 合格' });
  throwsCode(() => decodeSegment(buf.subarray(0, buf.length - 10)), 'E_TORN');
});

test('flipped byte -> E_TORN (checksum)', () => {
  const buf = encodeSegment({ id: 'c1', epoch: 1, text: '复验 合格' });
  buf[10] ^= 0xff;
  throwsCode(() => decodeSegment(buf), 'E_TORN');
});

test('tokenize splits on whitespace runs', () => {
  assert.deepEqual(tokenize('复验  合格\n准予'), ['复验', '合格', '准予']);
});

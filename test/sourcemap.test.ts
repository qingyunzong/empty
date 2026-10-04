import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { replace } from '../src/replace';
import { SourceMap } from '../src/sourcemap';

test('compose two rounds: inserted text stays unmapped', () => {
  const r1 = replace('abc', [{ start: 1, end: 2, captures: [] }], ['XY']); // aXYc
  const r2 = replace('aXYc', [{ start: 1, end: 3, captures: [{ start: 1, end: 2 }] }], ['$1$1']); // aXXc
  const composed = SourceMap.compose(r1.map, r2.map);
  assert.equal(composed.inLength, 3);
  assert.equal(composed.outLength, 4);
  assert.equal(composed.forward(0), 0); // 'a'
  assert.equal(composed.forward(1), null); // 'X' inserted in round 1
  assert.equal(composed.forward(2), null);
  assert.equal(composed.forward(3), 2); // 'c'
  assert.deepEqual(composed.inverse(0), [{ start: 0, end: 1 }]);
  assert.deepEqual(composed.inverse(1), []); // 'b' was deleted in round 1
  assert.deepEqual(composed.inverse(2), [{ start: 3, end: 4 }]);
});

test('compose propagates capture duplication across rounds', () => {
  const r1 = replace('ab', [{ start: 0, end: 1, captures: [{ start: 0, end: 1 }] }], ['$1$1']); // aab
  const r2 = replace('aab', [{ start: 0, end: 2, captures: [{ start: 0, end: 2 }] }], ['<$&>']); // <aa>b
  const composed = SourceMap.compose(r1.map, r2.map);
  assert.equal(composed.forward(0), null); // '<'
  assert.equal(composed.forward(1), 0);
  assert.equal(composed.forward(2), 0); // second copy of source 0
  assert.equal(composed.forward(3), null); // '>'
  assert.equal(composed.forward(4), 1); // 'b'
  assert.deepEqual(composed.inverse(0), [
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]);
});

test('identity round composes to identity', () => {
  const r = replace('abc', [], []);
  assert.equal(r.output, 'abc');
  const composed = SourceMap.compose(r.map, r.map);
  assert.equal(composed.forward(0), 0);
  assert.equal(composed.forward(2), 2);
  assert.deepEqual(composed.inverse(1), [{ start: 1, end: 2 }]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidCursorError,
  compareCursors,
  decodeCursor,
  encodeCursor,
} from '../src/cursor.ts';

test('cursor round-trips key and generation', () => {
  const cursor = encodeCursor('node-42', 7);
  assert.deepEqual(decodeCursor(cursor), { v: 1, key: 'node-42', gen: 7 });
});

test('compareCursors orders by embedded key', () => {
  const a = encodeCursor('a', 1);
  const b = encodeCursor('b', 1);
  const a2 = encodeCursor('a', 9);
  assert.equal(compareCursors(a, b), -1);
  assert.equal(compareCursors(b, a), 1);
  assert.equal(compareCursors(a, a2), 0);
});

test('decodeCursor rejects malformed input', () => {
  assert.throws(() => decodeCursor('not-a-cursor'), InvalidCursorError);
  assert.throws(
    () => decodeCursor(Buffer.from('{"v":2,"key":"a","gen":1}').toString('base64url')),
    InvalidCursorError,
  );
  assert.throws(
    () => decodeCursor(Buffer.from('{"v":1,"gen":1}').toString('base64url')),
    InvalidCursorError,
  );
});

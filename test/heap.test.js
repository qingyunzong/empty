import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MinHeap } from '../src/heap.js';
import { compareExpiry } from '../src/core.js';

const item = (id, expirySlot, priority = 0, seq = 0) => ({ id, expirySlot, priority, seq });

test('heap pops in deterministic (expiry, priority, seq, id) order', () => {
  const h = new MinHeap(compareExpiry);
  const items = [
    item('c', 5, 1, 2),
    item('a', 5, 1, 0),
    item('b', 5, 1, 1),
    item('d', 3, 9, 9),
    item('e', 5, 0, 7),
    item('f', 1, 0, 0),
  ];
  for (const it of items) h.push(it);
  const order = [];
  while (h.size > 0) order.push(h.pop().id);
  assert.deepEqual(order, ['f', 'd', 'e', 'a', 'b', 'c']);
});

test('discardWhile lazily evicts stale tops', () => {
  const h = new MinHeap(compareExpiry);
  const live = item('live', 4);
  const dead1 = item('dead1', 1);
  const dead2 = item('dead2', 2);
  h.push(dead1);
  h.push(dead2);
  h.push(live);
  h.discardWhile((a) => a.id.startsWith('dead'));
  assert.equal(h.peek().id, 'live');
  assert.equal(h.size, 1);
});

test('interleaved push/pop keeps order', () => {
  const h = new MinHeap(compareExpiry);
  h.push(item('x', 10));
  h.push(item('y', 2));
  assert.equal(h.pop().id, 'y');
  h.push(item('z', 3));
  assert.equal(h.pop().id, 'z');
  assert.equal(h.pop().id, 'x');
  assert.equal(h.pop(), undefined);
});

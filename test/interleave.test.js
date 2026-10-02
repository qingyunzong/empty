import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOrder } from '../src/interleave.js';

const ev = (id, ts, src) => ({ id, ts, src, kind: 'estop' });

test('canonical order sorts by ts then src priority', () => {
  const events = [
    ev('a', 5, 'plc'),
    ev('b', 5, 'safety'),
    ev('c', 3, 'plc'),
    ev('d', 5, 'photoeye'),
  ];
  const ordered = canonicalOrder(events, 42);
  assert.deepEqual(
    ordered.map((e) => e.id),
    ['c', 'b', 'd', 'a'],
  );
});

test('same-timestamp shuffle is reproducible for a fixed seed', () => {
  const events = Array.from({ length: 8 }, (_, i) => ev(`e${i}`, 7, 'safety'));
  const first = canonicalOrder(events, 123).map((e) => e.id);
  const second = canonicalOrder(events, 123).map((e) => e.id);
  assert.deepEqual(first, second);
  // a different seed may reorder, but the set of events is preserved
  const other = canonicalOrder(events, 456).map((e) => e.id);
  assert.deepEqual([...other].sort(), [...first].sort());
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AckRangeSet,
  normalizeAckRanges,
} from '../build/src/index.js';

test('ACK ranges are sorted and coalesced without per-number allocation', () => {
  const ranges = normalizeAckRanges([
    { smallest: 12, largest: 12 },
    { smallest: 4, largest: 7 },
    { smallest: 2, largest: 3 },
    { smallest: 9, largest: 10 },
    { smallest: 20, largest: 25 },
  ]);

  assert.deepEqual(ranges, [
    { smallest: 20, largest: 25 },
    { smallest: 12, largest: 12 },
    { smallest: 9, largest: 10 },
    { smallest: 2, largest: 7 },
  ]);
});

test('ACK membership handles gaps and boundaries', () => {
  const set = new AckRangeSet([
    { smallest: 7, largest: 9 },
    { smallest: 0, largest: 3 },
    { smallest: 5, largest: 5 },
  ]);

  assert.equal(set.largest, 9);
  assert.equal(set.smallest, 0);
  for (const packetNumber of [0, 1, 2, 3, 5, 7, 8, 9]) {
    assert.equal(set.has(packetNumber), true, `expected ${packetNumber}`);
  }
  for (const packetNumber of [-1, 4, 6, 10, 99]) {
    assert.equal(set.has(packetNumber), false, `unexpected ${packetNumber}`);
  }
});

test('invalid ACK ranges are rejected', () => {
  assert.throws(() => normalizeAckRanges([]), /at least one range/);
  assert.throws(
    () => normalizeAckRanges([{ smallest: 4, largest: 3 }]),
    /must not exceed/,
  );
  assert.throws(
    () => normalizeAckRanges([{ smallest: -1, largest: 3 }]),
    /non-negative safe integer/,
  );
  assert.throws(
    () => normalizeAckRanges([{ smallest: 0.5, largest: 3 }]),
    /non-negative safe integer/,
  );
});

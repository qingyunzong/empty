import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionQuota } from '../src/index.js';

test('equal partitioning preserves the quota exactly', () => {
  const shards = partitionQuota(7, ['a', 'b', 'c']);
  assert.deepEqual(shards, [
    { id: 'a', limit: 3 },
    { id: 'b', limit: 2 },
    { id: 'c', limit: 2 },
  ]);
});

test('weighted partitioning uses largest remainders', () => {
  const shards = partitionQuota(10, ['a', 'b'], [1, 3]);
  assert.deepEqual(shards, [
    { id: 'a', limit: 3 },
    { id: 'b', limit: 7 },
  ]);
  assert.equal(
    shards.reduce((sum, shard) => sum + shard.limit, 0),
    10,
  );
});

test('invalid shard configurations are rejected', () => {
  assert.throws(() => partitionQuota(2, ['a', 'b', 'c']), RangeError);
  assert.throws(() => partitionQuota(4, ['a', 'a']), RangeError);
  assert.throws(() => partitionQuota(4, ['a', 'b'], [1]), RangeError);
  assert.throws(() => partitionQuota(4, ['a', 'b'], [1, 0]), RangeError);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionVector } from '../src/version-vector.js';
import {
  DominanceEvidence,
  VersionedValue,
  contextOf,
  mergeSiblings,
} from '../src/siblings.js';

function item(tag: string, vv: VersionVector): VersionedValue<string> {
  return { value: tag, vv };
}

test('concurrent versions are all kept as a conflict set', () => {
  const a = item('a', VersionVector.zero().increment('A'));
  const b = item('b', VersionVector.zero().increment('B'));
  const merged = mergeSiblings([a, b]);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((s) => s.value).sort(),
    ['a', 'b'],
  );
});

test('dominated versions are retracted; evidence records the relation', () => {
  const v1 = VersionVector.zero().increment('A');
  const v2 = v1.increment('B');
  const evidence: DominanceEvidence[] = [];
  const merged = mergeSiblings([item('old', v1), item('new', v2)], evidence);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.value, 'new');
  const retraction = evidence.find((e) => e.relation === 'dominates');
  assert.ok(retraction, 'expected dominance evidence');
  assert.equal(retraction.kept, v2.toString());
  assert.equal(retraction.retracted, v1.toString());
});

test('a retracted version never resurrects through later merges', () => {
  const v1 = VersionVector.zero().increment('A');
  const v2 = v1.increment('B');
  const oldOne = item('retracted', v1);
  const winner = item('winner', v2);
  // First merge retracts v1.
  const step1 = mergeSiblings([oldOne, winner]);
  assert.equal(step1.length, 1);
  // A stale peer still holding v1 merges again: v1 must stay retracted.
  const step2 = mergeSiblings([...step1, oldOne]);
  assert.equal(step2.length, 1);
  assert.equal(step2[0]!.value, 'winner');
  // And in any order.
  const step3 = mergeSiblings([oldOne, winner, oldOne]);
  assert.equal(step3.length, 1);
});

test('contextOf joins all sibling vectors', () => {
  const a = item('a', VersionVector.from([['A', 1]]));
  const b = item('b', VersionVector.from([['B', 2]]));
  assert.equal(contextOf([a, b]).toString(), '{A:1, B:2}');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionVector } from '../src/version-vector.js';
test('increment and compare: strict dominance chain', () => {
    const v0 = VersionVector.zero();
    const v1 = v0.increment('A');
    const v2 = v1.increment('A');
    assert.equal(v0.compare(v0), 'equal');
    assert.equal(v2.compare(v1), 'dominates');
    assert.equal(v1.compare(v2), 'dominated');
    assert.equal(v2.compare(v0), 'dominates');
});
test('disjoint increments are concurrent, never ordered by clock', () => {
    const a = VersionVector.zero().increment('A');
    const b = VersionVector.zero().increment('B');
    assert.equal(a.compare(b), 'concurrent');
    assert.equal(b.compare(a), 'concurrent');
});
test('merge is pointwise max and is idempotent/commutative', () => {
    const a = VersionVector.from([['A', 2], ['B', 1]]);
    const b = VersionVector.from([['A', 1], ['C', 3]]);
    const m = a.merge(b);
    assert.equal(m.toString(), '{A:2, B:1, C:3}');
    assert.ok(a.merge(b).equals(b.merge(a)));
    assert.ok(m.merge(m).equals(m));
    assert.equal(m.compare(a), 'dominates');
});
test('zero counters are dropped and rejected when negative', () => {
    assert.equal(VersionVector.from([['A', 0]]).toString(), '{}');
    assert.throws(() => VersionVector.from([['A', -1]]));
});

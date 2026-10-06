import test from 'node:test';
import assert from 'node:assert/strict';
import { Fnv1aAdapter, fnv1a } from '../src/hash.js';
import { Ring, expandNodes } from '../src/ring.js';
import { MapAdapter, ReferenceRing, mulberry32 } from './helpers.js';
test('virtual nodes are ordered by hash, then node id, then replica index on collisions', () => {
    const adapter = new MapAdapter({ 'a#0': 100, 'b#0': 100, 'a#1': 50, 'b#1': 200 }, new Fnv1aAdapter());
    const specs = expandNodes([
        { id: 'b', weight: 1 },
        { id: 'a', weight: 1 },
    ], 2);
    const ring = Ring.create(1, specs.map((s) => ({ hash: adapter.hash(s.key), nodeId: s.nodeId, replica: s.replica })));
    assert.deepStrictEqual(ring.vnodes, [
        { hash: 50, nodeId: 'a', replica: 1 },
        { hash: 100, nodeId: 'a', replica: 0 },
        { hash: 100, nodeId: 'b', replica: 0 },
        { hash: 200, nodeId: 'b', replica: 1 },
    ]);
    assert.strictEqual(ring.ownerOfHash(100), 'a');
    assert.strictEqual(ring.ownerOfHash(101), 'b');
    assert.strictEqual(ring.ownerOfHash(200), 'b');
    assert.strictEqual(ring.ownerOfHash(201), 'a');
    assert.strictEqual(ring.ownerOfHash(0), 'a');
});
test('empty ring routes nothing and yields empty replica sets', () => {
    const empty = Ring.empty(0);
    assert.strictEqual(empty.ownerOfHash(0), undefined);
    assert.strictEqual(empty.ownerOfHash(0xffffffff), undefined);
    assert.deepStrictEqual(empty.replicasOfHash(42, 3), []);
    assert.deepStrictEqual(empty.ownershipPoints(), []);
    const alsoEmpty = Ring.create(1, []);
    assert.strictEqual(alsoEmpty.ownerOfHash(7), undefined);
    assert.deepStrictEqual(alsoEmpty.replicasOfHash(7, 2), []);
});
test('nodes with zero weight contribute no virtual nodes', () => {
    const specs = expandNodes([
        { id: 'a', weight: 0 },
        { id: 'b', weight: 2 },
    ], 3);
    assert.deepStrictEqual(specs.map((s) => s.key), ['b#0', 'b#1', 'b#2', 'b#3', 'b#4', 'b#5']);
    assert.throws(() => expandNodes([{ id: 'a', weight: -1 }], 1), /non-negative integer/);
});
test('replicas are always distinct physical nodes', () => {
    const quantized = { hash: (input) => fnv1a(input) & 0x7 };
    const specs = expandNodes([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
    ], 8);
    const ring = Ring.create(1, specs.map((s) => ({ hash: quantized.hash(s.key), nodeId: s.nodeId, replica: s.replica })));
    for (let h = 0; h < 16; h++) {
        const replicas = ring.replicasOfHash(h, 3);
        assert.strictEqual(new Set(replicas).size, 3);
        assert.deepStrictEqual([...replicas].sort(), ['a', 'b', 'c']);
        const two = ring.replicasOfHash(h, 2);
        assert.strictEqual(new Set(two).size, 2);
    }
    const single = Ring.create(2, expandNodes([{ id: 'a', weight: 1 }], 4).map((s) => ({
        hash: fnv1a(s.key),
        nodeId: s.nodeId,
        replica: s.replica,
    })));
    assert.deepStrictEqual(single.replicasOfHash(123, 3), ['a']);
});
test('binary-search ring matches fully-sorted reference ring (randomized, with collisions)', () => {
    const rng = mulberry32(0xc0ffee);
    const fnv = new Fnv1aAdapter();
    for (let iter = 0; iter < 40; iter++) {
        const nodeCount = 1 + Math.floor(rng() * 5);
        const nodes = Array.from({ length: nodeCount }, (_, i) => ({
            id: `n${i}`,
            weight: Math.floor(rng() * 3),
        }));
        const replicasPerWeight = 1 + Math.floor(rng() * 4);
        const adapter = iter % 2 === 0 ? fnv : { hash: (input) => fnv.hash(input) & 0x3f };
        const specs = expandNodes(nodes, replicasPerWeight);
        const ring = Ring.create(iter, specs.map((s) => ({ hash: adapter.hash(s.key), nodeId: s.nodeId, replica: s.replica })));
        const reference = new ReferenceRing(specs, adapter);
        const samples = new Set([0, 0xffffffff]);
        for (const vnode of ring.vnodes) {
            samples.add(vnode.hash);
            samples.add((vnode.hash + 1) >>> 0);
            if (vnode.hash > 0)
                samples.add(vnode.hash - 1);
        }
        for (let i = 0; i < 64; i++)
            samples.add(Math.floor(rng() * 0x100000000));
        for (const h of samples) {
            assert.strictEqual(ring.ownerOfHash(h), reference.ownerOfHash(h), `owner mismatch at ${h} (iter ${iter})`);
            for (const count of [0, 1, 2, 3, 5]) {
                assert.deepStrictEqual(ring.replicasOfHash(h, count), reference.replicasOfHash(h, count), `replicas mismatch at ${h} count ${count} (iter ${iter})`);
            }
        }
    }
});

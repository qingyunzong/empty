import test from 'node:test';
import assert from 'node:assert/strict';
import { Fnv1aAdapter, SyncAsyncHashAdapter } from '../src/hash.js';
import { Ring, expandNodes } from '../src/ring.js';
import { intervalContains, planMigration } from '../src/migration.js';
import { RingBuilder, SharedHashComputer } from '../src/builder.js';
import { Router } from '../src/router.js';
import { MapAdapter, assertPlanExact, mulberry32 } from './helpers.js';
function buildRing(version, nodes, adapter = new Fnv1aAdapter(), replicasPerWeight = 8) {
    const specs = expandNodes(nodes, replicasPerWeight);
    return Ring.create(version, specs.map((s) => ({ hash: adapter.hash(s.key) >>> 0, nodeId: s.nodeId, replica: s.replica })));
}
test('removing a node migrates exactly the keys it owned', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, weight: 1 }));
    const oldRing = buildRing(1, nodes);
    const newRing = buildRing(2, nodes.filter((n) => n.id !== 'b'));
    const plan = planMigration(oldRing, newRing);
    assert.ok(plan.length > 0);
    for (const interval of plan) {
        assert.strictEqual(interval.from, 'b');
        assert.notStrictEqual(interval.to, 'b');
    }
    for (const point of oldRing.ownershipPoints()) {
        if (point.nodeId === 'b') {
            assert.ok(plan.some((iv) => intervalContains(iv, point.hash)), `orphaned interval at ${point.hash}`);
        }
    }
    assertPlanExact(plan, oldRing, newRing);
});
test('weight change is published as a new ring version with an exact interval diff', async () => {
    const computer = new SharedHashComputer(new SyncAsyncHashAdapter(new Fnv1aAdapter()));
    const router = new Router(new RingBuilder(computer, 8));
    const ring1 = await router.publish([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
    ]);
    assert.strictEqual(ring1.version, 1);
    const cursor = router.acquireCursor();
    const ring2 = await router.publish([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 3 },
    ]);
    assert.strictEqual(ring2.version, 2);
    assert.strictEqual(router.current, ring2);
    const plan = planMigration(ring1, ring2);
    assert.ok(plan.length > 0);
    for (const interval of plan)
        assert.notStrictEqual(interval.from, interval.to);
    assertPlanExact(plan, ring1, ring2);
    assert.strictEqual(cursor.version, 1);
    const rng = mulberry32(42);
    for (let i = 0; i < 100; i++) {
        const h = Math.floor(rng() * 0x100000000);
        assert.strictEqual(cursor.routeHash(h), ring1.ownerOfHash(h));
    }
    cursor.release();
    assert.strictEqual(router.activeCursors, 0);
    assert.throws(() => cursor.routeHash(0), /released/);
});
test('migration intervals respect collision tie-breaks', () => {
    const oldAdapter = new MapAdapter({ 'a#0': 100, 'b#0': 100, 'c#0': 300 }, new Fnv1aAdapter());
    const oldRing = buildRing(1, [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
    ], oldAdapter, 1);
    assert.strictEqual(oldRing.ownerOfHash(100), 'a');
    const newAdapter = new MapAdapter({ 'b#0': 100, 'c#0': 300 }, new Fnv1aAdapter());
    const newRing = buildRing(2, [
        { id: 'b', weight: 1 },
        { id: 'c', weight: 1 },
    ], newAdapter, 1);
    assert.strictEqual(newRing.ownerOfHash(100), 'b');
    const plan = planMigration(oldRing, newRing);
    assert.deepStrictEqual(plan, [{ start: 300, end: 100, from: 'a', to: 'b' }]);
    assert.ok(intervalContains(plan[0], 100));
    assert.ok(intervalContains(plan[0], 50));
    assert.ok(intervalContains(plan[0], 400));
    assert.ok(!intervalContains(plan[0], 200));
    assertPlanExact(plan, oldRing, newRing);
});
test('removing the collision loser migrates nothing', () => {
    const oldAdapter = new MapAdapter({ 'a#0': 100, 'b#0': 100 }, new Fnv1aAdapter());
    const oldRing = buildRing(1, [
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
    ], oldAdapter, 1);
    const newAdapter = new MapAdapter({ 'a#0': 100 }, new Fnv1aAdapter());
    const newRing = buildRing(2, [{ id: 'a', weight: 1 }], newAdapter, 1);
    assert.deepStrictEqual(planMigration(oldRing, newRing), []);
});
test('empty ring transitions cover the full key space', () => {
    const empty = Ring.empty(0);
    const ring = buildRing(1, [{ id: 'a', weight: 1 }], new Fnv1aAdapter(), 4);
    const into = planMigration(empty, ring);
    assert.strictEqual(into.length, 1);
    assert.strictEqual(into[0].from, null);
    assert.strictEqual(into[0].to, 'a');
    assert.strictEqual(into[0].start, into[0].end);
    assert.ok(intervalContains(into[0], 0));
    assert.ok(intervalContains(into[0], 0xffffffff));
    const outOf = planMigration(ring, empty);
    assert.strictEqual(outOf.length, 1);
    assert.strictEqual(outOf[0].from, 'a');
    assert.strictEqual(outOf[0].to, null);
    assert.deepStrictEqual(planMigration(empty, Ring.empty(1)), []);
    assertPlanExact(into, empty, ring);
    assertPlanExact(outOf, ring, empty);
});
test('randomized reconfigurations produce exact interval diffs', () => {
    const rng = mulberry32(0xbadc0de);
    const fnv = new Fnv1aAdapter();
    const pick = () => {
        const count = Math.floor(rng() * 5);
        const ids = ['a', 'b', 'c', 'd', 'e'].sort(() => rng() - 0.5).slice(0, count);
        return ids.map((id) => ({ id, weight: 1 + Math.floor(rng() * 3) }));
    };
    for (let iter = 0; iter < 30; iter++) {
        const oldRing = buildRing(iter, pick(), fnv, 4);
        const newRing = buildRing(iter + 1, pick(), fnv, 4);
        assertPlanExact(planMigration(oldRing, newRing), oldRing, newRing);
    }
});

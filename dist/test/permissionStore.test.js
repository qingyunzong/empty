import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { PermissionStore } from '../src/permissionStore.js';
import { normalized, shuffled, mulberry32 } from './util.js';
test('concurrent grant and revoke of the same permission -> revoke wins', () => {
    const alice = new PermissionStore('alice');
    const bob = new PermissionStore('bob');
    const grant = alice.grant('repo:push'); // alice and bob have NOT synced
    const revoke = bob.revoke('repo:push'); // concurrent with the grant
    alice.receive(revoke);
    bob.receive(grant);
    for (const store of [alice, bob]) {
        const entry = store.effectiveFor('repo:push');
        equal(entry?.granted, false);
        deepEqual(entry?.revokedBy.map((s) => s.opId), ['bob#1']);
        deepEqual(entry?.sources, []);
    }
});
test('causal grant after a revoke restores the permission', () => {
    const alice = new PermissionStore('alice');
    const bob = new PermissionStore('bob');
    const revoke = bob.revoke('repo:push');
    alice.receive(revoke); // alice has SEEN the revoke...
    const grant = alice.grant('repo:push'); // ...so her grant causally follows it
    bob.receive(grant);
    for (const store of [alice, bob]) {
        const entry = store.effectiveFor('repo:push');
        equal(entry?.granted, true);
        deepEqual(entry?.sources.map((s) => s.opId), ['alice#1']);
        deepEqual(entry?.revokedBy, []);
    }
});
test('revoke causally after a grant removes the permission', () => {
    const alice = new PermissionStore('alice');
    const bob = new PermissionStore('bob');
    const grant = alice.grant('repo:push');
    bob.receive(grant); // bob has SEEN the grant
    const revoke = bob.revoke('repo:push'); // causally after it
    alice.receive(revoke);
    for (const store of [alice, bob]) {
        const entry = store.effectiveFor('repo:push');
        equal(entry?.granted, false);
        deepEqual(entry?.revokedBy.map((s) => s.opId), ['bob#1']);
    }
});
test('grant -> revoke -> grant chain: the newest causal grant wins', () => {
    const s = new PermissionStore('solo');
    s.grant('admin');
    s.revoke('admin');
    s.grant('admin');
    const entry = s.effectiveFor('admin');
    equal(entry?.granted, true);
    deepEqual(entry?.sources.map((x) => x.opId), ['solo#3']);
});
test('provenance: concurrent surviving grants are all reported as sources', () => {
    const alice = new PermissionStore('alice');
    const bob = new PermissionStore('bob');
    const g1 = alice.grant('docs:read');
    const g2 = bob.grant('docs:read'); // concurrent
    alice.receive(g2);
    bob.receive(g1);
    const entry = alice.effectiveFor('docs:read');
    equal(entry?.granted, true);
    deepEqual(entry?.sources.map((s) => s.opId), ['alice#1', 'bob#1']);
});
test('merging is order-independent: shuffled delivery converges to the same state', () => {
    const alice = new PermissionStore('alice');
    const bob = new PermissionStore('bob');
    const carol = new PermissionStore('carol');
    const ops = [
        alice.grant('p1'),
        bob.revoke('p1'), // concurrent revoke -> p1 revoked
        carol.grant('p2'),
        alice.grant('p3'),
        bob.grant('p3'), // concurrent grants -> both are sources
    ];
    carol.receive(ops[0]);
    ops.push(carol.revoke('p1')); // causally after alice's grant -> p1 stays revoked
    const baseline = new PermissionStore('baseline');
    baseline.merge(ops);
    const expected = normalized(baseline.effective());
    const rng = mulberry32(42);
    for (let trial = 0; trial < 50; trial++) {
        const replica = new PermissionStore(`replica-${trial}`);
        for (const op of shuffled(ops, rng))
            replica.receive(op); // out-of-order delivery
        deepEqual(normalized(replica.effective()), expected);
    }
    equal(expected['p1']?.granted, false);
    equal(expected['p2']?.granted, true);
    deepEqual(expected['p3']?.sources, ['alice#2', 'bob#2']);
});
test('duplicate delivery is idempotent', () => {
    const alice = new PermissionStore('alice');
    const bob = new PermissionStore('bob');
    const grant = alice.grant('p');
    equal(bob.receive(grant), true);
    equal(bob.receive(grant), false);
    equal(bob.receive(grant), false);
    equal(bob.snapshot().length, 1);
    equal(bob.effectiveFor('p')?.granted, true);
});
test('wall-clock metadata is never consulted: misleading timestamps cannot reorder causality', () => {
    // A revoke that is causally AFTER the grant but stamped with an EARLIER
    // wall clock must still revoke. A wall-clock-based (LWW) merge would
    // wrongly keep the grant.
    const grant = {
        id: 'alice#1', kind: 'grant', perm: 'p', replica: 'alice', counter: 1,
        clock: { alice: 1 }, wallClockMs: 9_999_999, // "newer" by wall clock
    };
    const revoke = {
        id: 'bob#1', kind: 'revoke', perm: 'p', replica: 'bob', counter: 1,
        clock: { alice: 1, bob: 1 }, // causally AFTER the grant (saw it)
        wallClockMs: 1, // "older" by wall clock
    };
    const store = new PermissionStore('observer');
    store.receive(revoke); // delivered out of order, too
    store.receive(grant);
    equal(store.effectiveFor('p')?.granted, false);
    // And a grant causally after a revoke restores even with an "older" stamp.
    const restore = {
        id: 'carol#1', kind: 'grant', perm: 'p', replica: 'carol', counter: 1,
        clock: { alice: 1, bob: 1, carol: 1 }, // causally after the revoke
        wallClockMs: 2,
    };
    store.receive(restore);
    const entry = store.effectiveFor('p');
    equal(entry?.granted, true);
    deepEqual(entry?.sources.map((s) => s.opId), ['carol#1']);
});
test('merge of snapshots is commutative and idempotent (CRDT join)', () => {
    const alice = new PermissionStore('alice');
    const bob = new PermissionStore('bob');
    alice.grant('x');
    alice.revoke('y');
    bob.grant('y');
    bob.grant('z');
    const snapA = alice.snapshot();
    const snapB = bob.snapshot();
    const intoAlice = alice.merge(snapB);
    const intoBob = bob.merge(snapA);
    ok(intoAlice > 0 && intoBob > 0);
    deepEqual(normalized(alice.effective()), normalized(bob.effective()));
    // Re-merging the same snapshots changes nothing.
    equal(alice.merge(snapB), 0);
    equal(bob.merge(snapA), 0);
    deepEqual(normalized(alice.effective()), normalized(bob.effective()));
});
test('independent permissions do not interfere', () => {
    const s = new PermissionStore('solo');
    s.grant('a');
    s.revoke('b'); // revoking a never-granted permission is recorded but harmless
    s.grant('c');
    const eff = normalized(s.effective());
    equal(eff['a']?.granted, true);
    equal(eff['b']?.granted, false);
    equal(eff['c']?.granted, true);
});

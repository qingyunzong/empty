import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionStore } from '../src/store.js';
import { compare } from '../src/vectorClock.js';
import type { Operation } from '../src/ops.js';

function fanout(stores: PermissionStore[], ops: Operation[]): void {
  for (const s of stores) for (const op of ops) s.apply(op);
}

test('concurrent grant and revoke of the same permission -> revoke wins', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const grant = a.grant('doc:read');
  const revoke = b.revoke('doc:read'); // concurrent: B has not seen A's grant
  assert.equal(compare(grant.clock, revoke.clock), 'concurrent');

  fanout([a, b], [grant, revoke]);
  assert.equal(a.isEffective('doc:read'), false);
  assert.equal(b.isEffective('doc:read'), false);
  assert.deepEqual(a.effective(), b.effective());
});

test('causally-later grant restores a revoked permission', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const g1 = a.grant('doc:write');
  const r1 = b.revoke('doc:write'); // concurrent with g1 -> kills it
  fanout([a, b], [g1, r1]);
  assert.equal(a.isEffective('doc:write'), false);

  const g2 = a.grant('doc:write'); // causally AFTER r1 (A has seen r1)
  assert.equal(compare(r1.clock, g2.clock), 'before');
  fanout([a, b], [g2]);
  assert.equal(a.isEffective('doc:write'), true);
  assert.equal(b.isEffective('doc:write'), true);

  const eff = a.effective().get('doc:write')!;
  assert.deepEqual(
    eff.sources.map((s) => s.opId),
    [g2.id],
  );
});

test('causally-later revoke wins over an earlier grant', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const g1 = a.grant('admin');
  b.apply(g1); // B sees the grant first
  const r1 = b.revoke('admin'); // causally after g1
  fanout([a, b], [g1, r1]);
  assert.equal(a.isEffective('admin'), false);
  assert.equal(b.isEffective('admin'), false);
});

test('grant -> revoke -> grant chain: only the last grant survives', () => {
  const a = new PermissionStore('A');
  const g1 = a.grant('p');
  const r1 = a.revoke('p');
  const g2 = a.grant('p');
  const eff = a.effective().get('p')!;
  assert.deepEqual(
    eff.sources.map((s) => s.opId),
    [g2.id],
  );
  assert.ok(g1 && r1); // ops exist in log but are not sources
});

test('out-of-order and duplicated delivery converges to the same state', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const g1 = a.grant('x');
  const r1 = b.revoke('x'); // concurrent
  a.apply(r1); // A causally observes the revoke...
  const g2 = a.grant('x'); // ...so g2 happens strictly after r1 and restores x
  const ops = [g1, r1, g2];

  const inbox1 = [g2, r1, g1, g2, r1]; // shuffled + duplicates
  const inbox2 = [r1, g1, g2, g1];
  const r1store = new PermissionStore('R1');
  const r2store = new PermissionStore('R2');
  for (const op of inbox1) r1store.apply(op);
  for (const op of inbox2) r2store.apply(op);

  fanout([a, b], ops);
  assert.equal(r1store.describe(), r2store.describe());
  assert.equal(r1store.describe(), a.describe());
  assert.equal(a.describe(), b.describe());
  assert.equal(r1store.isEffective('x'), true); // g2 causally after r1
});

test('state-based merge converges both ways', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  a.grant('m');
  b.revoke('m'); // concurrent revoke
  a.mergeFrom(b);
  b.mergeFrom(a);
  assert.equal(a.describe(), b.describe());
  assert.equal(a.isEffective('m'), false);
  assert.deepEqual(a.version(), b.version());
});

test('causal version, not wall clock, decides the outcome', () => {
  // Wall-clock says the revoke is OLDER than the grant; causality says
  // the revoke is concurrent -> remove-wins must still apply.
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const grant = a.grant('p', /* wallClockMs */ 1000);
  const revoke = b.revoke('p', /* wallClockMs */ 100); // skewed clock, "earlier"
  assert.ok(revoke.wallClockMs! < grant.wallClockMs!);
  fanout([a, b], [grant, revoke]);
  assert.equal(a.isEffective('p'), false, 'concurrent revoke wins despite older wall clock');

  // And a causally-later grant with an OLD wall clock still restores.
  const grant2 = a.grant('p', /* wallClockMs */ 50);
  fanout([a, b], [grant2]);
  assert.equal(a.isEffective('p'), true, 'causally-later grant wins despite oldest wall clock');
});

test('provenance: effective permission reports its surviving grant sources', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const g1 = a.grant('p');
  const g2 = b.grant('p'); // concurrent grants: both survive
  fanout([a, b], [g1, g2]);
  const eff = a.effective().get('p')!;
  assert.deepEqual(
    eff.sources.map((s) => s.opId).sort(),
    [g1.id, g2.id].sort(),
  );
  assert.deepEqual(
    eff.sources.map((s) => s.actor).sort(),
    ['A', 'B'],
  );
});

test('independent permissions do not interfere', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const g1 = a.grant('p');
  const r2 = b.revoke('q'); // different perm, concurrent
  fanout([a, b], [g1, r2]);
  assert.equal(a.isEffective('p'), true);
  assert.equal(a.isEffective('q'), false);
});

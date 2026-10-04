import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branch, ev } from './helpers.js';
import { mergeBranches } from '../src/merge.js';
import { MergeSession } from '../src/session.js';
import { Store } from '../src/store.js';
import { canonical } from '../src/canonical.js';
import { checkCertificate } from '../src/checker.js';

function makeStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'emstore-')));
}

function scenario() {
  const base = branch([
    ev('A', 1, { note: 'x' }),
    ev('D', 2, { note: 'keep' }),
    ev('F', 3, { dependsOn: ['D'] }),
  ]);
  const local = branch([
    ev('A', 1, { note: 'a' }),
    ev('D', 2, { note: 'keep', deleted: true }),
    ev('F', 3, { dependsOn: ['D'] }),
  ]);
  const remote = branch([
    ev('A', 1, { note: 'b' }),
    ev('D', 2, { note: 'edited' }),
    ev('F', 3, { dependsOn: ['D'] }),
  ]);
  return { base, local, remote };
}

test('resolve incrementally updates blocked state and certificate; matches full recompute', () => {
  const { base, local, remote } = scenario();
  const s = new MergeSession({ base, local, remote });
  assert.equal(s.result.conflicts.length, 2);
  const fieldC = s.result.conflicts.find((c) => c.type === 'FIELD');
  const duC = s.result.conflicts.find((c) => c.type === 'DELETE_UPDATE');

  // Tentative: D deleted -> F blocked.
  assert.deepEqual(s.result.blocked, [{ id: 'F', blockedBy: ['D'] }]);

  const r1 = s.resolve({ conflictId: fieldC.conflictId, expectLocal: 'a', expectRemote: 'b', pick: 'remote' });
  assert.equal(r1.ok, true);
  // Other conflict stays unresolved.
  assert.equal(s.unresolvedConflicts().length, 1);
  assert.equal(s.unresolvedConflicts()[0].conflictId, duC.conflictId);

  // Cross-check incremental state against a full recompute.
  let fresh = mergeBranches(base, local, remote, s.activeResolutions());
  assert.equal(canonical(s.result.events), canonical(fresh.events));
  assert.equal(canonical(s.result.blocked), canonical(fresh.blocked));
  assert.equal(canonical(s.result.certificate), canonical(fresh.certificate));

  // Unblock: pick remote for the DELETE_UPDATE (D stays alive with new note).
  const r2 = s.resolve({
    conflictId: duC.conflictId,
    expectLocal: duC.local,
    expectRemote: duC.remote,
    pick: 'remote',
  });
  assert.ok(r2.affected.includes('D'));
  assert.ok(r2.affected.includes('F'));
  assert.deepEqual(s.result.blocked, []);
  assert.equal(s.result.events.get('D').deleted, false);
  assert.equal(s.result.events.get('D').note, 'edited');
  assert.deepEqual(s.result.events.get('F').dependsOn, ['D']);
  assert.equal(checkCertificate(s.result.events, s.result.certificate).ok, true);

  fresh = mergeBranches(base, local, remote, s.activeResolutions());
  assert.equal(canonical(s.result.events), canonical(fresh.events));
  assert.equal(canonical(s.result.blocked), canonical(fresh.blocked));
  assert.equal(canonical(s.result.certificate), canonical(fresh.certificate));
});

test('resolve enforces source-version preconditions', () => {
  const { base, local, remote } = scenario();
  const s = new MergeSession({ base, local, remote });
  const fieldC = s.result.conflicts.find((c) => c.type === 'FIELD');
  assert.throws(
    () => s.resolve({ conflictId: fieldC.conflictId, expectLocal: 'WRONG', expectRemote: 'b', pick: 'local' }),
    (e) => e.code === 'PRECONDITION_FAILED',
  );
  assert.throws(
    () => s.resolve({ conflictId: 'nope', expectLocal: null, expectRemote: null, pick: 'local' }),
    (e) => e.code === 'UNKNOWN_CONFLICT',
  );
});

test('stale resolution: carried only while source versions still match', () => {
  const { base, local, remote } = scenario();
  const s = new MergeSession({ base, local, remote });
  const fieldC = s.result.conflicts.find((c) => c.type === 'FIELD');
  s.resolve({ conflictId: fieldC.conflictId, expectLocal: 'a', expectRemote: 'b', pick: 'local' });

  // Unrelated remote change: resolution carries over.
  const remoteTrivial = branch([
    ev('A', 1, { note: 'b' }),
    ev('D', 2, { note: 'edited', ackBy: 'op-9' }),
    ev('F', 3, { dependsOn: ['D'] }),
  ]);
  const r1 = s.updateBranch('remote', remoteTrivial);
  assert.deepEqual(r1.carried, [fieldC.conflictId]);
  assert.deepEqual(r1.stale, []);
  assert.equal(s.resolutions.get(fieldC.conflictId).status, 'ACTIVE');

  // Remote changes the contested value: resolution becomes STALE_RESOLUTION.
  const remoteChanged = branch([
    ev('A', 1, { note: 'c' }),
    ev('D', 2, { note: 'edited', ackBy: 'op-9' }),
    ev('F', 3, { dependsOn: ['D'] }),
  ]);
  const r2 = s.updateBranch('remote', remoteChanged);
  assert.deepEqual(r2.carried, []);
  assert.deepEqual(r2.stale, [fieldC.conflictId]);
  assert.equal(s.resolutions.get(fieldC.conflictId).status, 'STALE_RESOLUTION');
  // Stale resolution is not applied: tentative base value is back.
  assert.equal(s.result.events.get('A').note, 'x');
});

test('commit requires all conflicts resolved and a valid graph', () => {
  const { base, local, remote } = scenario();
  const store = makeStore();
  const s = new MergeSession({ base, local, remote });
  assert.throws(() => s.commit(store), (e) => e.code === 'UNRESOLVED_CONFLICTS');
  assert.equal(store.head(), null);

  // Cycle blocks commit too.
  const b2 = branch([ev('A', 1), ev('B', 2)]);
  const l2 = branch([ev('A', 1), ev('B', 2, { dependsOn: ['A'] })]);
  const r2 = branch([ev('A', 1, { dependsOn: ['B'] }), ev('B', 2)]);
  const s2 = new MergeSession({ base: b2, local: l2, remote: r2 });
  assert.throws(() => s2.commit(store), (e) => e.code === 'CYCLE');
});

test('commit writes immutable snapshot with parents; unblocked net diff is minimal', () => {
  const { base, local, remote } = scenario();
  const store = makeStore();
  const baseV = store.putSnapshot({ events: base, parents: [], meta: { kind: 'branch', name: 'base' } });
  const localV = store.putSnapshot({ events: local, parents: [baseV], meta: { kind: 'branch', name: 'local' } });
  const remoteV = store.putSnapshot({ events: remote, parents: [baseV], meta: { kind: 'branch', name: 'remote' } });

  const s = new MergeSession({ base, local, remote, versions: { base: baseV, local: localV, remote: remoteV } });
  for (const c of s.result.conflicts) {
    s.resolve({ conflictId: c.conflictId, expectLocal: c.local, expectRemote: c.remote, pick: 'remote' });
  }
  const mergeV = s.commit(store);
  assert.equal(store.head(), mergeV);
  const snap = store.getSnapshot(mergeV);
  assert.deepEqual(snap.parents, [localV, remoteV]);

  // Net diff base -> merge: only A.note and D.note changed; F's edge intact.
  const d = store.diff(baseV, mergeV);
  assert.deepEqual(
    d.ops.map((o) => `${o.op}:${o.id}`).sort(),
    ['set:A', 'set:D'],
  );
  assert.deepEqual(snap.events.get('F').dependsOn, ['D']);
  assert.deepEqual(snap.meta.blocked, []);

  // Immutability: same content yields the same version.
  assert.equal(store.putSnapshot({ events: snap.events, parents: snap.parents, meta: snap.meta }), mergeV);
});

test('inverse diff restores old snapshot; tampered post-image hash fails atomically', () => {
  const { base, local, remote } = scenario();
  const store = makeStore();
  const baseV = store.putSnapshot({ events: base, parents: [], meta: { kind: 'branch' } });
  const localV = store.putSnapshot({ events: local, parents: [baseV], meta: { kind: 'branch' } });
  const remoteV = store.putSnapshot({ events: remote, parents: [baseV], meta: { kind: 'branch' } });
  const s = new MergeSession({ base, local, remote, versions: { base: baseV, local: localV, remote: remoteV } });
  for (const c of s.result.conflicts) {
    s.resolve({ conflictId: c.conflictId, expectLocal: c.local, expectRemote: c.remote, pick: 'remote' });
  }
  const mergeV = s.commit(store);

  const diff = store.diff(baseV, mergeV);
  const inverse = store.invert(diff);
  const restoredV = store.applyInverse(mergeV, inverse);
  assert.equal(store.getSnapshot(restoredV).eventsHash, store.getSnapshot(baseV).eventsHash);

  // Tamper with the post-image hash: must fail without touching the store.
  const tampered = { ...inverse, toEventsHash: '0'.repeat(64) };
  const headBefore = store.head();
  assert.throws(() => store.applyInverse(mergeV, tampered), (e) => e.code === 'POSTIMAGE_HASH_MISMATCH');
  assert.equal(store.head(), headBefore);
  assert.equal(store.getSnapshot(mergeV).eventsHash, diff.toEventsHash);

  // Tamper with preimage too.
  const tamperedPre = { ...inverse, fromEventsHash: '1'.repeat(64) };
  assert.throws(() => store.applyInverse(mergeV, tamperedPre), (e) => e.code === 'PREIMAGE_HASH_MISMATCH');
});

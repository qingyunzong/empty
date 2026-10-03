import test from 'node:test';
import assert from 'node:assert/strict';
import { ev } from './helpers.js';
import { Repo } from '../src/repo.js';
import { computeDerived, computeBlocked } from '../src/derive.js';
import { clone } from '../src/util.js';

function repoWith(base, local, remote) {
  const repo = new Repo();
  repo.loadBranch('base', base);
  repo.loadBranch('local', local);
  repo.loadBranch('remote', remote);
  repo.merge();
  return repo;
}

test('resolve applies an explicit field choice and keeps other conflicts open', () => {
  const repo = repoWith(
    [ev('a', 1, { note: 'x', ackBy: null })],
    [ev('a', 1, { note: 'y', ackBy: 'ann' })],
    [ev('a', 1, { note: 'z', ackBy: 'bob' })],
  );
  assert.deepEqual(repo.status().unresolved.sort(), ['field:a:ackBy', 'field:a:note']);
  // Wrong preconditions are refused.
  assert.throws(
    () => repo.resolve({ conflictId: 'field:a:note', field: 'note', choice: 'local', expect: { local: 'WRONG', remote: 'z' } }),
    /preconditions/,
  );
  const st = repo.resolve({ conflictId: 'field:a:note', field: 'note', choice: 'local', expect: { local: 'y', remote: 'z' } });
  assert.deepEqual(st.unresolved, ['field:a:ackBy']);
  assert.equal(repo.mergeState.events.a.note, 'y');
  assert.equal(repo.mergeState.events.a.ackBy, null, 'unresolved conflict keeps tentative value');
});

test('incremental updates match a full recompute of the graph', () => {
  const repo = repoWith(
    [ev('a', 1, { note: 'x' }), ev('b', 2, { dependsOn: ['a'] }), ev('c', 3, { dependsOn: ['b'] })],
    [ev('a', 1, { note: 'x', deleted: true }), ev('b', 2, { dependsOn: ['a'] }), ev('c', 3, { dependsOn: ['b'] })],
    [ev('a', 1, { note: 'n1' }), ev('b', 2, { dependsOn: ['a'] }), ev('c', 3, { dependsOn: ['b'] })],
  );
  // DELETE_UPDATE on a: local retracted it, remote edited its note.
  assert.deepEqual(repo.status().unresolved, ['delete-update:a']);
  assert.deepEqual(repo.status().blocked, [{ event: 'b', blockedBy: ['a'] }]);
  // Choose the remote version of `deleted` (i.e. do not retract): b unblocks.
  repo.resolve({ conflictId: 'delete-update:a', field: 'deleted', choice: 'remote' });
  assert.deepEqual(repo.status().blocked, []);
  // The incrementally maintained derived state equals a full recompute.
  const full = computeDerived(repo.mergeState.events, repo.branchEvents(), repo.mergeState.dependsOnOrigin);
  assert.deepEqual(repo.mergeState.derived, full);
  assert.deepEqual(repo.mergeState.derived.blocked, computeBlocked(repo.mergeState.events));
  assert.deepEqual(repo.mergeState.derived.blocked, computeBlocked(repo.mergeState.events));
});

test('BLOCKED report clears after un-retraction; net diff is minimal', () => {
  const repo = repoWith(
    [ev('x', 1), ev('y', 2, { dependsOn: ['x'] })],
    [ev('x', 1, { deleted: true }), ev('y', 2, { dependsOn: ['x'] })],
    [ev('x', 1), ev('y', 2, { dependsOn: ['x'] })],
  );
  assert.deepEqual(repo.status().blocked, [{ event: 'y', blockedBy: ['x'] }]);
  const s1 = repo.mergeCommit();

  // Remote un-retracts x (moves back to deleted=false) -> blocked clears.
  repo.loadBranch('remote', [ev('x', 1, { deleted: false }), ev('y', 2, { dependsOn: ['x'] })]);
  repo.loadBranch('local', [ev('x', 1), ev('y', 2, { dependsOn: ['x'] })]);
  repo.merge();
  assert.deepEqual(repo.status().blocked, []);
  const s2 = repo.mergeCommit();

  const diff = repo.diff(s1.snapshotId, s2.snapshotId);
  assert.deepEqual(diff.ops, [
    { op: 'putEvent', id: 'x', event: ev('x', 1) },
  ], 'net diff after unblocking is exactly the deleted-flag flip');
});

test('resolutions become STALE_RESOLUTION when source versions move', () => {
  const repo = repoWith(
    [ev('a', 1, { note: 'x' })],
    [ev('a', 1, { note: 'y' })],
    [ev('a', 1, { note: 'z' })],
  );
  repo.resolve({ conflictId: 'field:a:note', field: 'note', choice: 'local', expect: { local: 'y', remote: 'z' } });
  assert.equal(repo.status().unresolved.length, 0);

  // Local branch changes its version of the contested field.
  repo.loadBranch('local', [ev('a', 1, { note: 'y2' })]);
  const st = repo.merge();
  assert.equal(st.staleResolutions.length, 1);
  assert.equal(st.staleResolutions[0].status, 'STALE_RESOLUTION');
  assert.deepEqual(st.unresolved, ['field:a:note'], 'conflict is open again');

  // A resolution whose preconditions still hold is carried over.
  repo.loadBranch('local', [ev('a', 1, { note: 'y' })]);
  const st2 = repo.merge();
  assert.equal(st2.staleResolutions.length, 0);
  assert.equal(st2.unresolved.length, 0);
  assert.equal(repo.mergeState.events.a.note, 'y');
});

test('mergeCommit is atomic and requires resolved conflicts and a valid graph', () => {
  const repo = repoWith(
    [ev('a', 1, { note: 'x' })],
    [ev('a', 1, { note: 'y' })],
    [ev('a', 1, { note: 'z' })],
  );
  assert.throws(() => repo.mergeCommit(), /unresolved conflicts/);
  assert.equal(repo.history.length, 0, 'failed commit leaves history untouched');

  repo.resolve({ conflictId: 'field:a:note', field: 'note', choice: 'remote' });
  const c1 = repo.mergeCommit();
  assert.equal(repo.index, c1.snapshotId);
  assert.deepEqual(c1.parents, []);

  // Cycle blocks commits too.
  const repo2 = repoWith(
    [ev('a', 1), ev('b', 2)],
    [ev('a', 1, { dependsOn: ['b'] }), ev('b', 2)],
    [ev('a', 1), ev('b', 2, { dependsOn: ['a'] })],
  );
  assert.ok(repo2.status().cycle);
  assert.throws(() => repo2.mergeCommit(), /not valid/);
  assert.equal(repo2.history.length, 0);
});

test('snapshots are immutable and record parents', () => {
  const repo = repoWith([ev('a', 1)], [ev('a', 2)], [ev('a', 1)]);
  const c1 = repo.mergeCommit();
  repo.loadBranch('remote', [ev('a', 2), ev('b', 5)]);
  repo.merge();
  const c2 = repo.mergeCommit();
  assert.deepEqual(c2.parents, [c1.snapshotId]);
  const snap = repo.snapshots.get(c1.snapshotId);
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.events));
  assert.throws(() => { snap.events.a.ts = 99; }, TypeError);
});

test('inverse diff rolls the index back only when the post-image hash verifies', () => {
  const repo = repoWith([ev('a', 1, { note: 'x' })], [ev('a', 1, { note: 'y' })], [ev('a', 1, { note: 'x' })]);
  const c1 = repo.mergeCommit();
  repo.loadBranch('local', [ev('a', 1, { note: 'z' })]);
  repo.loadBranch('remote', [ev('a', 1, { note: 'z' }), ev('b', 5)]);
  repo.merge();
  const c2 = repo.mergeCommit();

  const inv = repo.inverseDiff(c1.snapshotId, c2.snapshotId);
  assert.equal(inv.inverse, true);
  assert.equal(inv.postImageHash, repo.snapshots.get(c1.snapshotId).imageHash);

  // Tampered inverse diff: verification fails, history and index unchanged.
  const bad = clone(inv);
  bad.ops.push({ op: 'putEvent', id: 'ghost', event: ev('ghost', 0) });
  assert.throws(() => repo.applyInverseDiff(bad), /post-image hash mismatch/);
  assert.equal(repo.index, c2.snapshotId);
  assert.equal(repo.history.length, 2);

  // Preimage mismatch: diff does not apply to the current image.
  const repo3 = repoWith([ev('a', 1)], [ev('a', 1)], [ev('a', 1)]);
  repo3.mergeCommit();
  assert.throws(() => repo3.applyInverseDiff(inv), /does not apply/);

  // Genuine inverse diff applies and moves the index back.
  const res = repo.applyInverseDiff(inv);
  assert.equal(res.index, c1.snapshotId);
  assert.equal(repo.index, c1.snapshotId);
  assert.equal(repo.history.length, 2, 'history is append-only; only the index moved');
});

test('DELETE_UPDATE resolution can restore the event and its dependencies', () => {
  const repo = repoWith(
    [ev('a', 1, { note: 'x' }), ev('b', 0)],
    [ev('a', 1, { note: 'x', deleted: true }), ev('b', 0)],
    [ev('a', 1, { note: 'y', dependsOn: ['b'] }), ev('b', 0)],
  );
  assert.deepEqual(repo.status().unresolved, ['delete-update:a']);
  // Keep the retraction.
  repo.resolve({ conflictId: 'delete-update:a', field: 'deleted', choice: 'local' });
  assert.equal(repo.status().unresolved.length, 1, 'note/dependsOn still contested');
  repo.resolve({ conflictId: 'delete-update:a', field: 'note', choice: 'remote' });
  repo.resolve({ conflictId: 'delete-update:a', field: 'dependsOn', choice: 'remote' });
  const st = repo.status();
  assert.equal(st.unresolved.length, 0);
  assert.equal(repo.mergeState.events.a.deleted, true);
  assert.equal(repo.mergeState.events.a.note, 'y');
  assert.deepEqual(repo.mergeState.events.a.dependsOn, ['b']);
  const commit = repo.mergeCommit();
  const snap = repo.snapshots.get(commit.snapshotId);
  assert.equal(snap.events.a.deleted, true);
  // Projection hides the retracted event but keeps its metadata in the archive.
  const proj = repo.projection();
  assert.deepEqual(proj.events.map((e) => e.id), ['b']);
});

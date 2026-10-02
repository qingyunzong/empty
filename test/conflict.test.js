import test from 'node:test';
import assert from 'node:assert/strict';
import { Repo, RepoError } from '../src/repo.js';
import { tmpdir } from '../testutil/util.mjs';

function capture(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected function to throw');
}

// Acceptance 1: two concurrent corrections of the same key on divergent
// branches must surface as a detectable conflict, never a silent pick.
test('concurrent corrections of the same key produce a detectable conflict', () => {
  const repo = new Repo(tmpdir());
  const base = repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 1 }] },
    { branch: 'main' }
  );
  // branch b forks from the base; the two corrections are concurrent
  // (different processes, no dependency edge between them).
  const onB = repo.commitBatch(
    { processId: 'p3', clock: 1, deps: [], from: 'main', ops: [{ op: 'assert', key: 'k', value: 20 }] },
    { branch: 'b' }
  );
  const onMain = repo.commitBatch(
    { processId: 'p2', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 10 }] },
    { branch: 'main' }
  );
  assert.notEqual(onMain.versionId, onB.versionId);

  // forkinfo reports the divergence and the conflicting key without merging
  const info = repo.forkinfo();
  const pair = info.pairs.find((p) => (p.a === 'b' && p.b === 'main') || (p.a === 'main' && p.b === 'b'));
  assert.ok(pair, 'forkinfo must report the main/b pair');
  assert.deepEqual(pair.conflicts.map((c) => c.key), ['k']);
  assert.equal(pair.lca.length, 1);
  assert.equal(pair.lca[0], base.versionId);

  // merge refuses to pick a winner: E_CONFLICT with both candidate values
  const err = capture(() => repo.mergeBranches('main', 'b'));
  assert.ok(err instanceof RepoError);
  assert.equal(err.code, 'E_CONFLICT');
  const [c] = err.details.conflicts;
  assert.equal(c.key, 'k');
  assert.deepEqual(c.base, { t: 'a', v: 1 });
  assert.deepEqual(c.a, { t: 'a', v: 10 });
  assert.deepEqual(c.b, { t: 'a', v: 20 });

  // heads untouched by the failed merge; both branches keep their own truth
  assert.deepEqual(repo.viewRows('main'), { k: 10 });
  assert.deepEqual(repo.viewRows('b'), { k: 20 });
});

test('non-conflicting concurrent edits merge cleanly and unknown is not a failure', () => {
  const repo = new Repo(tmpdir());
  repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'a', value: 1 }] },
    { branch: 'main' }
  );
  repo.commitBatch(
    { processId: 'p3', clock: 1, deps: [], from: 'main', ops: [{ op: 'assert', key: 'y', value: 'by' }] },
    { branch: 'b' }
  );
  repo.commitBatch(
    { processId: 'p2', clock: 1, deps: [], ops: [{ op: 'assert', key: 'x', value: 'mx' }] },
    { branch: 'main' }
  );
  // 'y' is unknown on main and 'x' is unknown on b: both merge without error
  const r = repo.mergeBranches('main', 'b');
  assert.equal(r.merged, true);
  assert.deepEqual(repo.viewRows('main'), { a: 1, x: 'mx', y: 'by' });
  const mergeVersion = repo.getVersion(r.versionId);
  assert.equal(mergeVersion.parents.length, 2);
  assert.equal(mergeVersion.batch, null);
});

test('certificate: every version records parents, applied batch and row-level changes', () => {
  const repo = new Repo(tmpdir());
  const r1 = repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 1 }] },
    { branch: 'main' }
  );
  const r2 = repo.commitBatch(
    {
      processId: 'p1',
      clock: 2,
      deps: [r1.batchId],
      ops: [
        { op: 'assert', key: 'k', value: 2 },
        { op: 'assert', key: 'j', value: 9 },
        { op: 'retract', key: 'j' },
      ],
    },
    { branch: 'main' }
  );
  const v1 = repo.getVersion(r1.versionId);
  const v2 = repo.getVersion(r2.versionId);
  assert.deepEqual(v1.parents, []);
  assert.equal(v1.batch, r1.batchId);
  assert.deepEqual(v1.changes, [{ key: 'k', before: null, after: { t: 'a', v: 1 } }]);
  assert.deepEqual(v2.parents, [r1.versionId]);
  assert.equal(v2.batch, r2.batchId);
  // row-level add/del: k updated 1->2; j asserted then retracted in one batch
  assert.deepEqual(v2.changes, [
    { key: 'k', before: { t: 'a', v: 1 }, after: { t: 'a', v: 2 } },
    { key: 'j', before: null, after: { t: 'a', v: 9 } },
    { key: 'j', before: { t: 'a', v: 9 }, after: { t: 'r' } },
  ]);
  assert.deepEqual(repo.viewRows('main'), { k: 2 });
});

test('error codes: E_ORPHAN for unknown deps, E_BAD_PARENT for wrong parents', () => {
  const repo = new Repo(tmpdir());
  const orphan = capture(() =>
    repo.commitBatch({ processId: 'p1', clock: 1, deps: ['nope'], ops: [] }, { branch: 'main' })
  );
  assert.equal(orphan.code, 'E_ORPHAN');

  const r1 = repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 1 }] },
    { branch: 'main' }
  );
  const badParent = capture(() =>
    repo.commitBatch(
      { processId: 'p1', clock: 2, deps: [], parents: ['deadbeef'], ops: [] },
      { branch: 'main' }
    )
  );
  assert.equal(badParent.code, 'E_BAD_PARENT');
  const mismatch = capture(() =>
    repo.commitBatch({ processId: 'p1', clock: 2, deps: [], parents: [], ops: [] }, { branch: 'main' })
  );
  assert.equal(mismatch.code, 'E_BAD_PARENT');
  // correct declared parents are accepted
  const ok = repo.commitBatch(
    { processId: 'p1', clock: 2, deps: [], parents: [r1.versionId], ops: [] },
    { branch: 'main' }
  );
  assert.equal(ok.duplicate, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Repo } from '../src/repo.js';
import { tmpdir } from '../testutil/util.mjs';

// Acceptance 4: retracting data on one branch must not affect its sibling.
test('retracting a branch does not affect its sibling branch', () => {
  const repo = new Repo(tmpdir());
  repo.commitBatch(
    {
      processId: 'p1',
      clock: 1,
      deps: [],
      ops: [
        { op: 'assert', key: 'k', value: 1 },
        { op: 'assert', key: 'm', value: 7 },
      ],
    },
    { branch: 'main' }
  );
  repo.commitBatch(
    { processId: 'p2', clock: 1, deps: [], from: 'main', ops: [] },
    { branch: 'a' }
  );
  repo.commitBatch(
    { processId: 'p3', clock: 1, deps: [], from: 'main', ops: [] },
    { branch: 'b' }
  );
  // retract k on branch a only
  repo.commitBatch(
    { processId: 'p2', clock: 2, deps: [], ops: [{ op: 'retract', key: 'k' }] },
    { branch: 'a' }
  );

  assert.deepEqual(repo.viewRows('a'), { m: 7 }); // k retracted on a
  assert.deepEqual(repo.viewRows('b'), { k: 1, m: 7 }); // sibling untouched
  assert.deepEqual(repo.viewRows('main'), { k: 1, m: 7 }); // parent untouched

  // incremental per-branch maintenance: merging a into main must not leak
  // the retraction into b
  // main has not moved since the fork, so this is a fast-forward
  const r = repo.mergeBranches('main', 'a');
  assert.equal(r.reason, 'fast-forward');
  assert.deepEqual(repo.viewRows('main'), { m: 7 });
  assert.deepEqual(repo.viewRows('b'), { k: 1, m: 7 });
});

test('retract then re-assert on a branch leaves siblings stable across merges', () => {
  const repo = new Repo(tmpdir());
  repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'x', value: 'base' }] },
    { branch: 'main' }
  );
  repo.commitBatch({ processId: 'p2', clock: 1, deps: [], from: 'main', ops: [] }, { branch: 'work' });
  repo.commitBatch({ processId: 'p3', clock: 1, deps: [], from: 'main', ops: [] }, { branch: 'stable' });
  repo.commitBatch(
    { processId: 'p2', clock: 2, deps: [], ops: [{ op: 'retract', key: 'x' }] },
    { branch: 'work' }
  );
  repo.commitBatch(
    { processId: 'p2', clock: 3, deps: [], ops: [{ op: 'assert', key: 'x', value: 'fixed' }] },
    { branch: 'work' }
  );
  repo.mergeBranches('main', 'work');
  assert.deepEqual(repo.viewRows('main'), { x: 'fixed' });
  assert.deepEqual(repo.viewRows('stable'), { x: 'base' });
});

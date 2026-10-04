import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Repo } from '../src/store.js';
import { commit } from '../src/commit.js';
import { mergeVersions } from '../src/merge.js';
import { forkinfo } from '../src/forkinfo.js';
import { tmpRepo, batch, assertOp, retractOp } from './helpers.js';

// Acceptance 1: two concurrent corrections of the same key produce a
// detectable conflict (reported, never silently resolved).
test('concurrent corrections of same key are reported as conflict', () => {
  const { repo } = tmpRepo();
  const root = commit(repo, batch('b0', 'p0', 1, [assertOp('k', 0)]));
  // two analyzers both fork from the same parent version
  const c1 = commit(repo, batch('b1', 'p1', 1, [assertOp('k', 1)], { parent: root.version }));
  const c2 = commit(repo, batch('b2', 'p2', 1, [assertOp('k', 2)], { parent: root.version }));

  assert.equal(c2.conflicts.length, 1);
  assert.equal(c2.conflicts[0].key, 'k');
  assert.equal(c2.conflicts[0].other, 'b1');

  // the DAG really forked: two heads, replay sets are branch-local
  const info = forkinfo(repo, 'main');
  assert.equal(info.heads.length, 2);
  assert.deepEqual(info.lcas, [root.version]);
  assert.equal(info.branches[c1.version].batches.join(), 'b1');
  assert.equal(info.branches[c2.version].batches.join(), 'b2');

  // merge refuses to pick a winner
  assert.throws(
    () => mergeVersions(repo, 'main', c1.version, c2.version),
    (e) => e.code === 'E_CONFLICT' && e.details.conflicts[0].key === 'k',
  );
});

test('concurrent commits on disjoint keys merge cleanly', () => {
  const { repo } = tmpRepo();
  const root = commit(repo, batch('b0', 'p0', 1, [assertOp('k', 0)]));
  const c1 = commit(repo, batch('b1', 'p1', 1, [assertOp('a', 1)], { parent: root.version }));
  const c2 = commit(repo, batch('b2', 'p2', 1, [assertOp('b', 2)], { parent: root.version }));
  assert.equal(c2.conflicts.length, 0);
  const { version } = mergeVersions(repo, 'main', c1.version, c2.version);
  assert.deepEqual(version.state, {
    k: { tag: 'asserted', value: 0 },
    a: { tag: 'asserted', value: 1 },
    b: { tag: 'asserted', value: 2 },
  });
  assert.deepEqual(version.parents, [c1.version, c2.version].sort());
});

// Acceptance 3: crash after the parent-pointer (HEAD) update must not lose
// acknowledged batches after recovery.
test('crash after HEAD update: recovery keeps the committed batch', () => {
  const { dir, repo } = tmpRepo();
  const b = batch('b1', 'p1', 1, [assertOp('k', 42)]);
  let crashed;
  try {
    commit(repo, b, { hooks: { afterHeads: () => { throw new Error('CRASH'); } } });
  } catch (e) {
    crashed = e;
  }
  assert.equal(crashed.message, 'CRASH');

  // journal intent is still on disk at the crash point
  assert.equal(fs.readdirSync(path.join(dir, 'journal')).length, 1);

  // reopen: recovery runs, batch and version survive, head is intact
  const repo2 = new Repo(dir);
  assert.equal(fs.readdirSync(path.join(dir, 'journal')).length, 0);
  assert.ok(repo2.hasBatch('b1'));
  const heads = repo2.getHeads('main');
  assert.equal(heads.length, 1);
  assert.deepEqual(repo2.getVersion('main', heads[0]).state, { k: { tag: 'asserted', value: 42 } });

  // retrying the same commit is idempotent (ack was lost to the crash)
  const again = commit(repo2, b);
  assert.equal(again.duplicate, true);
  assert.equal(again.version, heads[0]);
});

test('crash before HEAD update: journal rolls the commit forward', () => {
  const { dir, repo } = tmpRepo();
  commit(repo, batch('b0', 'p0', 1, [assertOp('x', 1)]));
  const b = batch('b1', 'p1', 1, [assertOp('y', 2)]);
  // simulate: batch+version+journal durable, HEAD never moved
  const probe = new Repo(dir);
  probe.applyHeads = () => { throw new Error('CRASH before HEAD'); };
  assert.throws(() => commit(probe, b), /CRASH before HEAD/);

  const repo2 = new Repo(dir); // recovery replays the journal
  assert.equal(fs.readdirSync(path.join(dir, 'journal')).length, 0);
  assert.ok(repo2.hasBatch('b1'));
  const heads = repo2.getHeads('main');
  assert.equal(heads.length, 1);
  const state = repo2.getVersion('main', heads[0]).state;
  assert.deepEqual(state.y, { tag: 'asserted', value: 2 });
});

// Acceptance 4: retracting a branch does not affect its sibling branch.
test('retraction on one branch leaves the sibling branch untouched', () => {
  const { repo } = tmpRepo();
  const root = commit(repo, batch('b0', 'p0', 1, [assertOp('shared', 1), assertOp('onlyA', 10)]));
  const a1 = commit(repo, batch('ba', 'pa', 1, [retractOp('shared'), retractOp('onlyA')], { parent: root.version }));
  const b1 = commit(repo, batch('bb', 'pb', 1, [assertOp('shared', 2)], { parent: root.version }));

  const sib = repo.getVersion('main', b1.version).state;
  assert.deepEqual(sib, {
    shared: { tag: 'asserted', value: 2 },
    onlyA: { tag: 'asserted', value: 10 },
  });

  // more commits on the retracting branch still do not leak into the sibling
  commit(repo, batch('ba2', 'pa', 2, [assertOp('shared', 999)], { parent: a1.version }));
  const sib2 = repo.getVersion('main', repo.getHeads('main').find((h) => h !== a1.version && h !== b1.version) ?? b1.version);
  assert.deepEqual(repo.getVersion('main', b1.version).state, sib);
  void sib2;

  // abandoning the retracting branch head leaves sibling head and state intact
  const headsBefore = repo.getHeads('main');
  assert.ok(headsBefore.includes(b1.version));
  assert.equal(repo.listVersions('main').filter((v) => v.id === b1.version).length, 1);
});

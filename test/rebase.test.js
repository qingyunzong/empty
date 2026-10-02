import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rebase, validateHistory, stateAt, applyPatch, snapshotHash,
  computeCommitHash, RebaseError,
} from '../src/rebase.js';
import { run as runCli } from '../src/cli.js';

// Builds a commit on top of a base state, computing context + hash.
function buildCommit(parent, number, patch, baseState) {
  const state = structuredClone(baseState);
  applyPatch(state, patch);
  const context = snapshotHash(state);
  const hash = computeCommitHash({ parent, number, patch, context });
  return { commit: { hash, parent, number, patch, context }, state };
}

// Replays a list of commits in the given order from a base state,
// returning every intermediate tree (tree-by-tree replay).
function replayTrees(commits, baseState = {}) {
  const trees = [];
  let state = structuredClone(baseState);
  for (const c of commits) {
    state = applyPatch(state, c.patch);
    trees.push(structuredClone(state));
  }
  return trees;
}

// Enumerates all topological orders of at most 3 commits (parents first).
function allTopoOrders(commits) {
  assert.ok(commits.length <= 3, 'test helper only supports <= 3 commits');
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const results = [];
  const walk = (remaining, prefix, done) => {
    if (remaining.length === 0) {
      results.push(prefix);
      return;
    }
    for (const c of remaining) {
      const parentReady = c.parent === null || !byHash.has(c.parent) || done.has(c.parent);
      if (parentReady) {
        walk(remaining.filter((x) => x !== c), [...prefix, c], new Set([...done, c.hash]));
      }
    }
  };
  walk(commits, [], new Set());
  return results;
}

function invokeCli(args) {
  let stderr = '';
  const status = runCli(args, (s) => { stderr += s; });
  return { status, stderr };
}

function writeHistory(dir, commits, branches = {}) {
  const file = join(dir, 'history.json');
  writeFileSync(file, JSON.stringify({ commits, branches }, null, 2));
  return file;
}

test('clean rebase: parents/hashes rewritten, numbers mapped, replay matches old branch', () => {
  const c1 = buildCommit(null, 1, [{ op: 'set', path: 'a', value: 1 }], {});
  const trunk = buildCommit(c1.commit.hash, 2, [{ op: 'set', path: 't', value: 9 }], c1.state);
  const b1 = buildCommit(c1.commit.hash, 3, [{ op: 'set', path: 'b', value: 2, old: null }], c1.state);
  const b2 = buildCommit(b1.commit.hash, 4, [{ op: 'move', from: 'b', to: 'c' }], b1.state);
  const commits = [c1.commit, trunk.commit, b1.commit, b2.commit];

  // Case 1: rebase onto the unchanged base — replayed tree must equal the old branch tip.
  const sameBase = rebase(commits, b2.commit.hash, c1.commit.hash);
  assert.equal(sameBase.commits.length, 2);
  assert.deepEqual(sameBase.state, b2.state);
  assert.deepEqual(sameBase.state, stateAt(validateHistory(commits), b2.commit.hash));

  // Case 2: rebase onto the advanced trunk — branch effect preserved on top of trunk state.
  const result = rebase(commits, b2.commit.hash, trunk.commit.hash);
  assert.equal(result.commits.length, 2);
  assert.equal(result.commits[0].parent, trunk.commit.hash);
  assert.equal(result.commits[1].parent, result.commits[0].hash);
  assert.deepEqual(result.commits.map((c) => c.number), [3, 4]);
  assert.notEqual(result.commits[0].hash, b1.commit.hash);
  assert.notEqual(result.commits[1].hash, b2.commit.hash);
  assert.equal(result.mapping[b1.commit.hash], result.commits[0].hash);
  assert.equal(result.mapping[b2.commit.hash], result.commits[1].hash);
  // Final tree = trunk state + branch effect ({b:2} moved to {c:2}).
  assert.deepEqual(result.state, { a: 1, t: 9, c: 2 });
  // Replayed trees of the rebased history match per-commit context snapshots.
  const trees = replayTrees(result.commits, trunk.state);
  assert.deepEqual(trees.at(-1), result.state);
  result.commits.forEach((c, i) => assert.equal(snapshotHash(trees[i]), c.context));
});

test('context conflict: record moved in trunk aborts rebase and writes nothing', () => {
  const c1 = buildCommit(null, 1, [{ op: 'set', path: 'rec', value: 'v1' }], {});
  // Trunk moves the record away.
  const trunk = buildCommit(c1.commit.hash, 2, [{ op: 'move', from: 'rec', to: 'rec2' }], c1.state);
  // Branch depends on the old path and old value.
  const b1 = buildCommit(c1.commit.hash, 3, [{ op: 'set', path: 'rec', value: 'v2', old: 'v1' }], c1.state);
  const commits = [c1.commit, trunk.commit, b1.commit];

  assert.throws(
    () => rebase(commits, b1.commit.hash, trunk.commit.hash),
    (err) => err instanceof RebaseError && err.code === 'CONFLICT' && /rec/.test(err.message),
  );

  // CLI: exit code 1 and no partial output files.
  const dir = mkdtempSync(join(tmpdir(), 'rebase-conflict-'));
  const file = writeHistory(dir, commits);
  const run = invokeCli(['rebase', '--history', file, '--branch', b1.commit.hash, '--onto', trunk.commit.hash, '--out-dir', dir]);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /CONFLICT/);
  assert.equal(existsSync(join(dir, 'rebased.json')), false);
  assert.equal(existsSync(join(dir, 'mapping.json')), false);
});

test('empty patch commits are collapsed but kept in the mapping', () => {
  const c1 = buildCommit(null, 1, [{ op: 'set', path: 'a', value: 1 }], {});
  const empty = buildCommit(c1.commit.hash, 2, [], c1.state);
  const b2 = buildCommit(empty.commit.hash, 3, [{ op: 'set', path: 'b', value: 2 }], empty.state);
  const commits = [c1.commit, empty.commit, b2.commit];

  const result = rebase(commits, b2.commit.hash, c1.commit.hash);
  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0].number, 3);
  assert.equal(result.commits[0].parent, c1.commit.hash);
  assert.equal(result.mapping[empty.commit.hash], null);
  assert.equal(result.mapping[b2.commit.hash], result.commits[0].hash);
  assert.deepEqual(result.state, b2.state);

  // CLI happy path writes both files.
  const dir = mkdtempSync(join(tmpdir(), 'rebase-collapse-'));
  const file = writeHistory(dir, commits, { feature: b2.commit.hash, main: c1.commit.hash });
  const run = invokeCli(['rebase', '--history', file, '--branch', 'feature', '--onto', 'main', '--out-dir', dir]);
  assert.equal(run.status, 0, run.stderr);
  const rebased = JSON.parse(readFileSync(join(dir, 'rebased.json'), 'utf8'));
  const mapping = JSON.parse(readFileSync(join(dir, 'mapping.json'), 'utf8'));
  assert.equal(rebased.length, 1);
  assert.equal(mapping[empty.commit.hash], null);
  assert.equal(mapping[b2.commit.hash], rebased[0].hash);
});

test('invalid histories fail: cycle, broken parent chain, duplicate numbers', () => {
  const c1 = buildCommit(null, 1, [{ op: 'set', path: 'a', value: 1 }], {});
  const c2 = buildCommit(c1.commit.hash, 2, [{ op: 'set', path: 'b', value: 2 }], c1.state);

  // Cyclic ancestry: two commits pointing at each other.
  const cyclic = [
    { ...c1.commit, parent: c2.commit.hash },
    { ...c2.commit, parent: c1.commit.hash },
  ];
  assert.throws(() => validateHistory(cyclic),
    (err) => err instanceof RebaseError && err.code === 'CYCLE');

  // Broken parent chain: parent hash not present in history.
  const broken = [c1.commit, { ...c2.commit, parent: '0'.repeat(64) }];
  assert.throws(() => validateHistory(broken),
    (err) => err instanceof RebaseError && err.code === 'BROKEN_PARENT');

  // Duplicate experiment numbers.
  const dup = [c1.commit, { ...c2.commit, number: 1 }];
  assert.throws(() => validateHistory(dup),
    (err) => err instanceof RebaseError && err.code === 'DUPLICATE_NUMBER');

  // CLI exits 1 for each invalid history.
  for (const [name, commits] of [['cycle', cyclic], ['broken', broken], ['dup', dup]]) {
    const dir = mkdtempSync(join(tmpdir(), `rebase-${name}-`));
    const file = writeHistory(dir, commits);
    const run = invokeCli(['rebase', '--history', file, '--branch', commits.at(-1).hash, '--onto', commits[0].hash, '--out-dir', dir]);
    assert.equal(run.status, 1, `${name}: expected exit 1, got ${run.status} (${run.stdout})`);
    assert.equal(existsSync(join(dir, 'rebased.json')), false, `${name}: no partial output`);
  }
});

test('topological orders of <= 3 commits replay to identical trees', () => {
  // Diamond: root A with two independent children B and C (commuting patches).
  const a = buildCommit(null, 1, [{ op: 'set', path: 'x', value: 1 }], {});
  const b = buildCommit(a.commit.hash, 2, [{ op: 'set', path: 'y', value: 2 }], a.state);
  const c = buildCommit(a.commit.hash, 3, [{ op: 'move', from: 'x', to: 'z' }], a.state);
  const commits = [a.commit, b.commit, c.commit];

  const orders = allTopoOrders(commits);
  assert.deepEqual(orders.map((o) => o.map((x) => x.number)), [[1, 2, 3], [1, 3, 2]]);

  // Replay every order tree-by-tree; all final trees must agree.
  const finals = orders.map((order) => replayTrees(order).at(-1));
  for (const tree of finals) assert.deepEqual(tree, { y: 2, z: 1 });

  // Rebasing the A->B chain onto C's tip must reproduce, tree-by-tree, the
  // same final tree that every topological order replayed to above.
  const byHash = validateHistory(commits);
  const result = rebase(commits, b.commit.hash, c.commit.hash);
  assert.equal(result.commits.length, 1);
  const rebasedTrees = replayTrees(result.commits, stateAt(byHash, c.commit.hash));
  assert.deepEqual(rebasedTrees.at(-1), finals[0]);
  assert.deepEqual(result.state, finals[0]);
});

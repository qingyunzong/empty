'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commitHash, hashValue } = require('../src/hash');
const { clone } = require('../src/tree');
const { applyPatch, ConflictError } = require('../src/patch');
const { validateRepo, treeAt, RepoError } = require('../src/repo');
const { rebase } = require('../src/rebase');
const { run: runCli } = require('../src/cli');

// --- helpers ---------------------------------------------------------------

class RepoBuilder {
  constructor() {
    this.commits = {};
    this.trees = new Map();
    this.branches = {};
  }

  commit(parent, number, patch) {
    const parentTree = parent ? this.trees.get(parent) : {};
    const commit = { parent, number, patch, context: hashValue(parentTree) };
    const hash = commitHash(commit);
    this.commits[hash] = commit;
    this.trees.set(hash, applyPatch(clone(parentTree), patch));
    return hash;
  }

  repo() {
    return validateRepo({ commits: this.commits, branches: this.branches });
  }
}

// Enumerate every topological order of the given commit hashes (parent
// edges restricted to the set must be respected). Used with <= 3 commits.
function topoOrders(commits, hashes) {
  const inSet = new Set(hashes);
  const orders = [];
  const backtrack = (order, remaining) => {
    if (remaining.size === 0) {
      orders.push(order.slice());
      return;
    }
    for (const hash of Array.from(remaining)) {
      const parent = commits[hash].parent;
      if (parent !== null && inSet.has(parent) && remaining.has(parent)) continue;
      order.push(hash);
      remaining.delete(hash);
      backtrack(order, remaining);
      remaining.add(hash);
      order.pop();
    }
  };
  backtrack([], new Set(hashes));
  return orders;
}

// Replay `hashes` (in order) on top of `baseTree`, returning the tree after
// every prefix so callers can compare tree-by-tree.
function replayPrefixes(repo, baseTree, hashes) {
  const trees = [];
  let tree = clone(baseTree);
  for (const hash of hashes) {
    tree = applyPatch(tree, repo.commits[hash].patch);
    trees.push(clone(tree));
  }
  return trees;
}

// Run the CLI in-process (the offline sandbox forbids spawning child
// processes), capturing stdout/stderr and the resulting exit code.
function runCliCaptured(args) {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExitCode = process.exitCode;
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  process.exitCode = 0;
  let code;
  try {
    code = runCli(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExitCode;
  }
  return { status: code, stdout, stderr };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-rebase-'));
}

function writeRepo(dir, repo) {
  const file = path.join(dir, 'repo.json');
  fs.writeFileSync(file, JSON.stringify(repo, null, 2));
  return file;
}

// Build the canonical clean-rebase fixture:
//   root -- m1 (main)
//    \-- f1 -- f2 -- f3 (feature)
function buildCleanFixture() {
  const b = new RepoBuilder();
  const root = b.commit(null, 1, [
    { op: 'set', path: 'config.env', value: 'dev' },
    { op: 'set', path: 'data.a', value: 1 },
  ]);
  const m1 = b.commit(root, 2, [{ op: 'set', path: 'meta.version', value: 2 }]);
  const f1 = b.commit(root, 3, [{ op: 'set', path: 'data.b', value: 2 }]);
  const f2 = b.commit(f1, 4, [{ op: 'replace', path: 'data.a', old: 1, new: 10 }]);
  const f3 = b.commit(f2, 5, [{ op: 'move', from: 'data.b', to: 'data.c' }]);
  b.branches.main = m1;
  b.branches.feature = f3;
  return { builder: b, repo: b.repo(), root, m1, f1, f2, f3 };
}

// --- clean rebase ----------------------------------------------------------

test('clean rebase rewrites parents/hashes, keeps numbers, replays identically', () => {
  const { repo, m1, f1, f2, f3 } = buildCleanFixture();
  const result = rebase(repo, 'feature', 'main');

  assert.equal(result.commits.length, 3);
  assert.equal(result.onto, m1);

  // Parent chain and hashes were rewritten.
  assert.equal(result.commits[0].parent, m1);
  assert.equal(result.commits[1].parent, result.commits[0].hash);
  assert.equal(result.commits[2].parent, result.commits[1].hash);
  assert.notEqual(result.commits[0].hash, f1);
  assert.equal(result.tip, result.commits[2].hash);

  // Original experiment numbers are preserved, in order.
  assert.deepEqual(result.commits.map((c) => c.number), [3, 4, 5]);
  assert.deepEqual(
    [f1, f2, f3].map((h) => result.mapping[h].number),
    [3, 4, 5],
  );
  assert.ok([f1, f2, f3].every((h) => result.mapping[h].collapsed === false));

  // New commit hashes are self-consistent and context-aware.
  for (const c of result.commits) {
    assert.equal(commitHash(c), c.hash);
  }

  // Enumerate the topological orders of the <= 3 rebased commits and
  // compare trees prefix-by-prefix: replaying the new history on the new
  // base must match replaying the original patches on the new base.
  const oldHashes = [f1, f2, f3];
  const orders = topoOrders(repo.commits, oldHashes);
  assert.ok(orders.length >= 1);
  const ontoTree = treeAt(repo, m1);
  const newHashes = result.commits.map((c) => c.hash);
  const newRepo = { commits: {}, branches: {} };
  for (const c of result.commits) newRepo.commits[c.hash] = c;
  for (const order of orders) {
    const oldTrees = replayPrefixes(repo, ontoTree, order);
    const newTrees = replayPrefixes(newRepo, ontoTree, newHashes);
    assert.equal(oldTrees.length, newTrees.length);
    for (let i = 0; i < oldTrees.length; i += 1) {
      assert.deepEqual(newTrees[i], oldTrees[i]);
    }
  }
});

test('rebase onto the original base reproduces the old branch tree exactly', () => {
  const { builder, repo, root, f3 } = buildCleanFixture();
  const repoWithBase = { ...repo, branches: { ...repo.branches, base: root } };
  const result = rebase(repoWithBase, 'feature', 'base');
  const replayed = replayPrefixes(
    { commits: Object.fromEntries(result.commits.map((c) => [c.hash, c])) },
    treeAt(repo, root),
    result.commits.map((c) => c.hash),
  ).at(-1);
  assert.deepEqual(replayed, builder.trees.get(f3));
});

test('clean rebase via CLI writes rebased.json and mapping.json', () => {
  const { repo, m1, f1, f2, f3 } = buildCleanFixture();
  const dir = tmpdir();
  const repoFile = writeRepo(dir, repo);
  const outdir = path.join(dir, 'out');
  const proc = runCliCaptured(['rebase', '--repo', repoFile, '--branch', 'feature', '--onto', 'main', '--outdir', outdir]);

  assert.equal(proc.status, 0, proc.stderr);
  const rebased = JSON.parse(fs.readFileSync(path.join(outdir, 'rebased.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(outdir, 'mapping.json'), 'utf8'));

  assert.equal(rebased.onto, m1);
  assert.equal(rebased.commits.length, 3);
  assert.equal(rebased.tip, rebased.commits[2].hash);
  assert.deepEqual(
    [f1, f2, f3].map((h) => mapping.commits[h].number),
    [3, 4, 5],
  );
  assert.equal(mapping.numbers['3'], mapping.commits[f1].newHash);
  assert.equal(mapping.numbers['5'], rebased.tip);
});

// --- conflict on moved record ----------------------------------------------

test('move of a record moved on the trunk conflicts and writes nothing', () => {
  const b = new RepoBuilder();
  const root = b.commit(null, 1, [{ op: 'set', path: 'record.a', value: { x: 1 } }]);
  const m1 = b.commit(root, 2, [{ op: 'move', from: 'record.a', to: 'record.archived' }]);
  const f1 = b.commit(root, 3, [{ op: 'set', path: 'other', value: true }]);
  const f2 = b.commit(f1, 4, [{ op: 'move', from: 'record.a', to: 'record.b' }]);
  b.branches.main = m1;
  b.branches.feature = f2;
  const repo = b.repo();

  assert.throws(() => rebase(repo, 'feature', 'main'), ConflictError);

  const dir = tmpdir();
  const repoFile = writeRepo(dir, repo);
  const outdir = path.join(dir, 'out');
  const proc = runCliCaptured(['rebase', '--repo', repoFile, '--branch', 'feature', '--onto', 'main', '--outdir', outdir]);

  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /conflict:/);
  assert.match(proc.stderr, /record\.a/);
  // No partial new history may be written.
  assert.ok(!fs.existsSync(path.join(outdir, 'rebased.json')));
  assert.ok(!fs.existsSync(path.join(outdir, 'mapping.json')));
});

test('replace depending on a trunk-changed old value conflicts', () => {
  const b = new RepoBuilder();
  const root = b.commit(null, 1, [{ op: 'set', path: 'cfg.level', value: 1 }]);
  const m1 = b.commit(root, 2, [{ op: 'set', path: 'cfg.level', value: 99 }]);
  const f1 = b.commit(root, 3, [{ op: 'replace', path: 'cfg.level', old: 1, new: 2 }]);
  b.branches.main = m1;
  b.branches.feature = f1;
  const repo = b.repo();

  assert.throws(() => rebase(repo, 'feature', 'main'), ConflictError);
});

// --- empty commit collapse ---------------------------------------------------

test('empty patches collapse but stay in the mapping', () => {
  const b = new RepoBuilder();
  const root = b.commit(null, 1, [{ op: 'set', path: 'base', value: 0 }]);
  const m1 = b.commit(root, 2, [{ op: 'set', path: 'trunk', value: 1 }]);
  const f1 = b.commit(root, 3, [{ op: 'set', path: 'a', value: 1 }]);
  const f2 = b.commit(f1, 4, []); // empty patch
  const f3 = b.commit(f2, 5, [{ op: 'set', path: 'b', value: 2 }]);
  b.branches.main = m1;
  b.branches.feature = f3;
  const repo = b.repo();

  const result = rebase(repo, 'feature', 'main');

  // Only the two non-empty commits produce new history.
  assert.equal(result.commits.length, 2);
  assert.deepEqual(result.commits.map((c) => c.number), [3, 5]);

  // The mapping still covers all three original commits.
  assert.equal(Object.keys(result.mapping).length, 3);
  assert.equal(result.mapping[f2].collapsed, true);
  assert.equal(result.mapping[f2].number, 4);
  assert.equal(result.mapping[f2].newHash, result.mapping[f1].newHash);
  assert.equal(result.mapping[f3].newHash, result.tip);

  // Replay equality on the new base, tree-by-tree over the <= 3 commits.
  const ontoTree = treeAt(repo, m1);
  const orders = topoOrders(repo.commits, [f1, f2, f3]);
  assert.ok(orders.length >= 1);
  const nonEmptyOrder = [f1, f3];
  const newRepo = { commits: Object.fromEntries(result.commits.map((c) => [c.hash, c])) };
  for (const order of orders) {
    const oldTrees = replayPrefixes(repo, ontoTree, order);
    const oldFinal = oldTrees.at(-1);
    const newTrees = replayPrefixes(newRepo, ontoTree, result.commits.map((c) => c.hash));
    assert.deepEqual(newTrees.at(-1), oldFinal);
    // Empty commit contributes no tree change, so the collapsed replay of
    // the non-empty commits matches the old history at every non-empty step.
    const oldNonEmptyTrees = replayPrefixes(repo, ontoTree, nonEmptyOrder);
    assert.deepEqual(newTrees, oldNonEmptyTrees);
  }
});

// --- structural errors -------------------------------------------------------

test('cyclic ancestry exits 1', () => {
  const repo = {
    commits: {
      aaa: { parent: 'bbb', number: 1, patch: [], context: 'x' },
      bbb: { parent: 'aaa', number: 2, patch: [], context: 'y' },
    },
    branches: { main: 'aaa', feature: 'bbb' },
  };
  assert.throws(() => validateRepo(repo), /cyclic ancestry/);

  const dir = tmpdir();
  const repoFile = writeRepo(dir, repo);
  const proc = runCliCaptured(['rebase', '--repo', repoFile, '--branch', 'feature', '--onto', 'main', '--outdir', path.join(dir, 'out')]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /cyclic ancestry/);
});

test('broken parent chain exits 1', () => {
  const repo = {
    commits: {
      aaa: { parent: 'missing', number: 1, patch: [], context: 'x' },
    },
    branches: { main: 'aaa', feature: 'aaa' },
  };
  assert.throws(() => validateRepo(repo), /broken parent chain/);

  const dir = tmpdir();
  const repoFile = writeRepo(dir, repo);
  const proc = runCliCaptured(['rebase', '--repo', repoFile, '--branch', 'feature', '--onto', 'main', '--outdir', path.join(dir, 'out')]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /broken parent chain/);
});

test('duplicate experiment numbers exit 1', () => {
  const b = new RepoBuilder();
  const root = b.commit(null, 1, [{ op: 'set', path: 'a', value: 1 }]);
  const dup = b.commit(root, 1, [{ op: 'set', path: 'b', value: 2 }]);
  const repo = { commits: b.commits, branches: { main: root, feature: dup } };
  assert.throws(() => validateRepo(repo), /duplicate experiment number 1/);

  const dir = tmpdir();
  const repoFile = writeRepo(dir, repo);
  const proc = runCliCaptured(['rebase', '--repo', repoFile, '--branch', 'feature', '--onto', 'main', '--outdir', path.join(dir, 'out')]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /duplicate experiment number/);
});

test('RepoError is used for structural problems, not ConflictError', () => {
  const b = new RepoBuilder();
  const root = b.commit(null, 1, [{ op: 'set', path: 'a', value: 1 }]);
  b.branches.main = root;
  const repo = b.repo();
  assert.throws(() => rebase(repo, 'feature', 'main'), RepoError);
  assert.throws(() => rebase(repo, 'main', 'nope'), RepoError);
});

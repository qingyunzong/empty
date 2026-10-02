'use strict';
const { clone } = require('./tree');
const { applyPatch, ConflictError } = require('./patch');
const { commitHash, hashValue } = require('./hash');
const { RepoError, ancestors, treeAt } = require('./repo');

// Collect commits reachable from `branchTip` but not from `ontoTip`,
// returned oldest-first.
function collectCommits(repo, branchTip, ontoTip) {
  const ontoAncestors = ancestors(repo, ontoTip);
  const todo = [];
  let cur = branchTip;
  while (cur !== null && !ontoAncestors.has(cur)) {
    const commit = repo.commits[cur];
    if (!commit) throw new RepoError(`broken parent chain: unknown commit ${cur}`);
    todo.push(cur);
    cur = commit.parent;
  }
  todo.reverse();
  return todo;
}

// Rebase the commits of `branchName` that are not ancestors of `ontoName`
// onto the tip of `ontoName`. Empty patches are collapsed but kept in the
// mapping. Throws ConflictError on the first context conflict; nothing is
// written by this function in any case.
function rebase(repo, branchName, ontoName) {
  const branchTip = repo.branches[branchName];
  if (!branchTip) throw new RepoError(`unknown branch: ${branchName}`);
  const ontoTip = repo.branches[ontoName];
  if (!ontoTip) throw new RepoError(`unknown branch: ${ontoName}`);

  const todo = collectCommits(repo, branchTip, ontoTip);
  const memo = new Map();
  let tree = treeAt(repo, ontoTip, memo);
  let parent = ontoTip;
  const commits = [];
  const mapping = {};

  for (const oldHash of todo) {
    const old = repo.commits[oldHash];
    if (old.patch.length === 0) {
      mapping[oldHash] = { number: old.number, newHash: parent, collapsed: true };
      continue;
    }
    let newTree;
    try {
      newTree = applyPatch(clone(tree), old.patch);
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new ConflictError(
          `context conflict while rebasing commit ${oldHash} (experiment ${old.number}): ${err.message}`,
          err.op,
        );
      }
      throw err;
    }
    const context = hashValue(tree);
    const commit = { parent, number: old.number, patch: old.patch, context };
    const hash = commitHash(commit);
    commits.push({ hash, ...commit });
    mapping[oldHash] = { number: old.number, newHash: hash, collapsed: false };
    parent = hash;
    tree = newTree;
  }

  return { onto: ontoTip, tip: parent, commits, mapping };
}

module.exports = { rebase, collectCommits };

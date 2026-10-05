'use strict';

const fs = require('node:fs');

const {
  canonical,
  stateHash,
  shortHash,
  composePatches,
  applyPatch,
  leafEffectiveThresholds,
  diffTrees,
} = require('./tree');
const { ConflictError, mergePatches } = require('./merge');

class IntervalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntervalError';
    this.code = 'RANGE';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
  }
}

function validateRepo(repo) {
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
    throw new ValidationError('repo must be a JSON object');
  }
  if (!repo.base || typeof repo.base !== 'object') {
    throw new ValidationError('repo.base (device tree) is missing');
  }
  if (!Array.isArray(repo.commits)) {
    throw new ValidationError('repo.commits must be an array');
  }
  const seen = new Set();
  for (const commit of repo.commits) {
    if (!commit || typeof commit.hash !== 'string' || commit.hash.length === 0) {
      throw new ValidationError('every commit needs a non-empty string hash');
    }
    if (seen.has(commit.hash)) {
      throw new ValidationError(`duplicate commit hash: ${commit.hash}`);
    }
    seen.add(commit.hash);
    for (const parent of commit.parents || []) {
      if (!seen.has(parent)) {
        throw new ValidationError(`commit ${commit.hash} references unknown or later parent ${parent}`);
      }
    }
  }
  if (repo.head !== undefined && !seen.has(repo.head)) {
    throw new ValidationError(`unknown head commit: ${repo.head}`);
  }
}

function loadRepo(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ValidationError(`cannot read repo file ${file}: ${err.message}`);
  }
  let repo;
  try {
    repo = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`invalid JSON in ${file}: ${err.message}`);
  }
  validateRepo(repo);
  return repo;
}

// Replay all commits (array order must be topological) and return
// Map(hash -> { tree, stateHash }). Stored stateHash values are verified.
function computeStates(repo) {
  const states = new Map();
  for (const commit of repo.commits) {
    const parents = commit.parents || [];
    const parentTree = parents.length > 0 ? states.get(parents[0]).tree : repo.base;
    const tree = applyPatch(parentTree, commit.patch || {});
    const hash = stateHash(tree);
    if (commit.stateHash !== undefined && commit.stateHash !== hash) {
      throw new ValidationError(
        `stateHash mismatch at commit ${commit.hash}: stored ${commit.stateHash}, computed ${hash}`,
      );
    }
    states.set(commit.hash, { tree, stateHash: hash });
  }
  return states;
}

function withStateHashes(repo, extra) {
  const states = computeStates(repo);
  return {
    ...repo,
    ...extra,
    commits: repo.commits.map((c) => ({ ...c, stateHash: states.get(c.hash).stateHash })),
  };
}

// Commits on the first-parent chain strictly after `fromHash`, up to and
// including `toHash`, in chronological order. Every commit on the chain
// must have exactly one parent (linear segment).
function chainBetween(repo, fromHash, toHash) {
  const byHash = new Map(repo.commits.map((c) => [c.hash, c]));
  if (!byHash.has(fromHash)) throw new IntervalError(`unknown commit: ${fromHash}`);
  if (!byHash.has(toHash)) throw new IntervalError(`unknown commit: ${toHash}`);
  const chain = [];
  let cur = byHash.get(toHash);
  while (cur.hash !== fromHash) {
    chain.unshift(cur);
    const parents = cur.parents || [];
    if (parents.length !== 1) {
      throw new IntervalError(`commit ${cur.hash} does not have exactly one parent (non-linear history)`);
    }
    const parent = byHash.get(parents[0]);
    if (!parent) throw new IntervalError(`${toHash} is not a descendant of ${fromHash}`);
    cur = parent;
  }
  return chain;
}

function composeChain(chain) {
  return chain.map((c) => c.patch || {}).reduce(composePatches, {});
}

// Squash the commits in (fromHash, toHash] into a single structured patch.
// Works on a temporary history; on any verification failure the original
// repo is left untouched and an error is thrown.
function squash(repo, fromHash, toHash) {
  const segment = chainBetween(repo, fromHash, toHash);
  if (segment.length === 0) {
    throw new IntervalError('empty range: nothing to squash');
  }
  for (const commit of segment) {
    if (commit.sealed) {
      throw new IntervalError(`cannot squash across sealed commit ${commit.hash}`);
    }
  }
  const segmentHashes = new Set(segment.map((c) => c.hash));
  for (const commit of repo.commits) {
    if (segmentHashes.has(commit.hash)) continue;
    for (const parent of commit.parents || []) {
      if (segmentHashes.has(parent) && parent !== toHash) {
        throw new IntervalError(`commit ${commit.hash} branches from inside the squash range`);
      }
    }
  }

  const composed = composeChain(segment);
  const newHash = 'sq-' + shortHash({ parents: [fromHash], patch: composed });
  const squashed = { hash: newHash, parents: [fromHash], sealed: false, patch: composed };

  const newCommits = [];
  for (const commit of repo.commits) {
    if (segmentHashes.has(commit.hash)) {
      if (commit.hash === segment[0].hash) newCommits.push(squashed);
      continue;
    }
    const parents = (commit.parents || []).map((p) => (p === toHash ? newHash : p));
    newCommits.push({ ...commit, parents });
  }

  const mapping = {};
  for (const commit of repo.commits) {
    mapping[commit.hash] = segmentHashes.has(commit.hash) ? newHash : commit.hash;
  }
  const oldHead = repo.head !== undefined ? repo.head : repo.commits[repo.commits.length - 1].hash;
  const newHead = mapping[oldHead];

  // --- verification on the temporary history ---
  const candidate = { ...repo, commits: newCommits, head: newHead };
  const oldStates = computeStates(repo);
  const newStates = computeStates(candidate);
  const sameState = (a, b) =>
    a.stateHash === b.stateHash &&
    canonical(a.tree) === canonical(b.tree) &&
    canonical(leafEffectiveThresholds(a.tree)) === canonical(leafEffectiveThresholds(b.tree));
  if (!sameState(oldStates.get(toHash), newStates.get(newHash))) {
    throw new ValidationError('squash verification failed at range end; original history preserved');
  }
  if (!sameState(oldStates.get(oldHead), newStates.get(newHead))) {
    throw new ValidationError('squash verification failed at head; original history preserved');
  }

  return { repo: withStateHashes(candidate, { mapping }), squashedHash: newHash };
}

// Three-way merge of two commits against their common base commit.
// Appends a merge commit (parents [leftHash, rightHash]) whose patch is the
// diff from the left state to the merged state.
function merge(repo, baseHash, leftHash, rightHash) {
  const leftPatch = composeChain(chainBetween(repo, baseHash, leftHash));
  const rightPatch = composeChain(chainBetween(repo, baseHash, rightHash));
  const { patch, conflicts } = mergePatches(leftPatch, rightPatch);
  if (conflicts.length > 0) throw new ConflictError(conflicts);

  const states = computeStates(repo);
  const mergedState = applyPatch(states.get(baseHash).tree, patch);
  const commitPatch = diffTrees(states.get(leftHash).tree, mergedState);
  const hash = 'mg-' + shortHash({ parents: [leftHash, rightHash], patch: commitPatch });
  const commit = { hash, parents: [leftHash, rightHash], sealed: false, patch: commitPatch };
  const next = { ...repo, commits: [...repo.commits, commit], head: hash };
  return { repo: withStateHashes(next), mergeHash: hash };
}

module.exports = {
  IntervalError,
  ValidationError,
  ConflictError,
  validateRepo,
  loadRepo,
  computeStates,
  chainBetween,
  squash,
  merge,
};

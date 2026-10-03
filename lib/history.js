'use strict';

const {
  normalizeTree,
  canonical,
  sha256hex,
  stateHash,
  leafEffectiveStates,
  deepEqual,
} = require('./tree');
const { PatchError, applyPatch, diffTrees } = require('./patch');

class RangeError2 extends Error {
  constructor(message) {
    super(message);
    this.name = 'RangeError2';
  }
}

function commitHash(parentHash, patch, commitStateHash, sealed) {
  return sha256hex(canonical({
    parent: parentHash || null,
    patch: patch || {},
    sealed: !!sealed,
    state: commitStateHash,
  }));
}

function loadHistory(repo) {
  if (!repo || typeof repo !== 'object') throw new RangeError2('repo must be an object');
  const base = normalizeTree(repo.base || {});
  const commits = [];
  const states = [base];
  let state = base;
  let parentHash = null;
  for (const raw of repo.commits || []) {
    const patch = raw.patch || {};
    state = applyPatch(state, patch);
    const sHash = stateHash(state);
    const hash = commitHash(parentHash, patch, sHash, raw.sealed);
    commits.push({ hash, sealed: !!raw.sealed, patch, stateHash: sHash });
    states.push(state);
    parentHash = hash;
  }
  return { base, commits, states };
}

function serializeCommits(commits) {
  return commits.map((commit) => ({
    hash: commit.hash,
    sealed: commit.sealed,
    stateHash: commit.stateHash,
    patch: commit.patch,
  }));
}

function squash(repo, fromHash, toHash) {
  const { base, commits } = loadHistory(repo);

  const fromIndex = commits.findIndex((commit) => commit.hash === fromHash);
  const toIndex = commits.findIndex((commit) => commit.hash === toHash);
  if (fromIndex === -1) throw new RangeError2(`unknown --from commit "${fromHash}"`);
  if (toIndex === -1) throw new RangeError2(`unknown --to commit "${toHash}"`);
  if (fromIndex > toIndex) throw new RangeError2('--from commit comes after --to commit');

  for (let index = fromIndex; index <= toIndex; index += 1) {
    if (commits[index].sealed) {
      throw new RangeError2(`range crosses sealed commit ${commits[index].hash}`);
    }
  }

  const stateBefore = fromIndex === 0 ? base : applyChain(base, commits, fromIndex - 1);
  const stateAfter = applyChain(base, commits, toIndex);
  const expectedStateHash = commits[toIndex].stateHash;
  const expectedLeaves = leafEffectiveStates(stateAfter);

  const squashedPatch = diffTrees(stateBefore, stateAfter);

  const rebuilt = commits.slice(0, fromIndex).map((commit) => ({ ...commit }));
  let parentHash = rebuilt.length > 0 ? rebuilt[rebuilt.length - 1].hash : null;

  const squashedStateHash = stateHash(stateAfter);
  const squashed = {
    hash: commitHash(parentHash, squashedPatch, squashedStateHash, false),
    sealed: false,
    patch: squashedPatch,
    stateHash: squashedStateHash,
  };
  rebuilt.push(squashed);
  parentHash = squashed.hash;

  const mapping = {};
  for (let index = fromIndex; index <= toIndex; index += 1) {
    mapping[commits[index].hash] = squashed.hash;
  }
  for (let index = toIndex + 1; index < commits.length; index += 1) {
    const original = commits[index];
    const hash = commitHash(parentHash, original.patch, original.stateHash, original.sealed);
    rebuilt.push({ ...original, hash });
    mapping[original.hash] = hash;
    parentHash = hash;
  }

  verify(base, rebuilt, fromIndex, expectedStateHash, expectedLeaves, commits, toIndex);

  return {
    repo: { base, commits: serializeCommits(rebuilt), squashMap: mapping },
    mapping,
    squashedHash: squashed.hash,
  };
}

function applyChain(base, commits, toIndex) {
  let state = normalizeTree(base);
  for (let index = 0; index <= toIndex; index += 1) {
    state = applyPatch(state, commits[index].patch);
  }
  return state;
}

function verify(base, rebuilt, squashedIndex, expectedStateHash, expectedLeaves, originalCommits, originalToIndex) {
  let state = normalizeTree(base);
  for (let index = 0; index <= squashedIndex; index += 1) {
    state = applyPatch(state, rebuilt[index].patch);
  }
  if (stateHash(state) !== expectedStateHash) {
    throw new RangeError2('squash verification failed: stateHash mismatch');
  }
  if (!deepEqual(leafEffectiveStates(state), expectedLeaves)) {
    throw new RangeError2('squash verification failed: leaf effective thresholds mismatch');
  }
  const rebuiltTip = applyChain(state, rebuilt.slice(squashedIndex + 1), rebuilt.length - squashedIndex - 2);
  const originalTip = applyChain(base, originalCommits, originalCommits.length - 1);
  if (rebuilt.length - 1 > squashedIndex || originalCommits.length - 1 > originalToIndex) {
    if (stateHash(rebuiltTip) !== stateHash(originalTip)) {
      throw new RangeError2('squash verification failed: tip stateHash mismatch');
    }
    if (!deepEqual(leafEffectiveStates(rebuiltTip), leafEffectiveStates(originalTip))) {
      throw new RangeError2('squash verification failed: tip leaf thresholds mismatch');
    }
  }
}

module.exports = { RangeError2, PatchError, commitHash, loadHistory, squash, applyChain };

import { canonicalize, sha256hex } from './canonical.js';
import { applyPatch } from './patch.js';

// Commit hash specification (normative):
//   fileHash(f)   = sha256hex(utf8 content of f)
//   commitHash(c) = sha256hex(canonicalize({
//     parent:  <hash of previous commit, or null>,
//     author:  c.author,
//     message: c.message,
//     patch:   c.patch,
//     files:   { <path>: fileHash, ... }   // full snapshot after applying c
//   }))
export function computeCommitHash(commit, parentHash, fileHashes) {
  return sha256hex(canonicalize({
    parent: parentHash,
    author: commit.author ?? null,
    message: commit.message ?? null,
    patch: commit.patch ?? [],
    files: fileHashes,
  }));
}

export function snapshotHashes(store) {
  const files = {};
  for (const name of Object.keys(store).sort()) {
    files[name] = sha256hex(store[name]);
  }
  return files;
}

// Replays commits from the empty state, recomputing per-commit file hashes
// and commit hashes per the specification above.
// Returns { store, results: [{ hash, files }] }.
export function replay(commits) {
  const store = {};
  const results = [];
  let parent = null;
  for (const commit of commits) {
    applyPatch(store, commit.patch ?? []);
    const files = snapshotHashes(store);
    const hash = computeCommitHash(commit, parent, files);
    results.push({ hash, files });
    parent = hash;
  }
  return { store, results };
}

// Replays and checks any recorded `files`/`hash` fields on the commits.
// Returns a list of human-readable integrity problems (empty = valid).
export function verifyHistory(commits) {
  const problems = [];
  const { results } = replay(commits);
  commits.forEach((commit, i) => {
    if (commit.hash !== undefined && commit.hash !== results[i].hash) {
      problems.push(`commit ${i}: recorded hash ${commit.hash} != recomputed ${results[i].hash}`);
    }
    if (commit.files !== undefined) {
      const expected = JSON.stringify(results[i].files);
      if (JSON.stringify(commit.files) !== expected) {
        problems.push(`commit ${i}: recorded file hashes do not match recomputed snapshot`);
      }
    }
  });
  return problems;
}

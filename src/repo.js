'use strict';
const fs = require('node:fs');
const { clone } = require('./tree');
const { applyPatch } = require('./patch');

class RepoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepoError';
  }
}

function validateRepo(repo) {
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
    throw new RepoError('repo file must contain a JSON object');
  }
  if (!repo.commits || typeof repo.commits !== 'object' || Array.isArray(repo.commits)) {
    throw new RepoError('repo must contain a "commits" object');
  }
  if (!repo.branches || typeof repo.branches !== 'object' || Array.isArray(repo.branches)) {
    throw new RepoError('repo must contain a "branches" object');
  }
  const byNumber = new Map();
  for (const [hash, c] of Object.entries(repo.commits)) {
    if (!c || typeof c !== 'object') throw new RepoError(`commit ${hash}: must be an object`);
    if (c.parent !== null && typeof c.parent !== 'string') {
      throw new RepoError(`commit ${hash}: parent must be a hash or null`);
    }
    if (typeof c.number !== 'number' || !Number.isInteger(c.number)) {
      throw new RepoError(`commit ${hash}: number must be an integer`);
    }
    if (!Array.isArray(c.patch)) throw new RepoError(`commit ${hash}: patch must be an array`);
    if (typeof c.context !== 'string') throw new RepoError(`commit ${hash}: context must be a hash string`);
    if (byNumber.has(c.number)) {
      throw new RepoError(
        `duplicate experiment number ${c.number} (commits ${byNumber.get(c.number)} and ${hash})`,
      );
    }
    byNumber.set(c.number, hash);
  }
  for (const [hash, c] of Object.entries(repo.commits)) {
    if (c.parent !== null && !repo.commits[c.parent]) {
      throw new RepoError(`broken parent chain: commit ${hash} references missing parent ${c.parent}`);
    }
  }
  // Cycle detection on the functional parent graph (white/gray/black walk).
  const color = new Map();
  for (const start of Object.keys(repo.commits)) {
    if ((color.get(start) || 0) !== 0) continue;
    const stack = [];
    let cur = start;
    while (cur !== null && (color.get(cur) || 0) === 0) {
      color.set(cur, 1);
      stack.push(cur);
      cur = repo.commits[cur].parent;
    }
    if (cur !== null && color.get(cur) === 1) {
      throw new RepoError(`cyclic ancestry detected at commit ${cur}`);
    }
    for (const h of stack) color.set(h, 2);
  }
  for (const [name, tip] of Object.entries(repo.branches)) {
    if (typeof tip !== 'string' || !repo.commits[tip]) {
      throw new RepoError(`branch "${name}" points at unknown commit ${String(tip)}`);
    }
  }
  return repo;
}

function loadRepo(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new RepoError(`cannot read repo file ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new RepoError(`cannot parse repo file ${file}: ${err.message}`);
  }
  return validateRepo(data);
}

function ancestors(repo, tip) {
  const set = new Set();
  let cur = tip;
  while (cur !== null) {
    if (set.has(cur)) throw new RepoError(`cyclic ancestry detected at commit ${cur}`);
    set.add(cur);
    const commit = repo.commits[cur];
    if (!commit) throw new RepoError(`broken parent chain: unknown commit ${cur}`);
    cur = commit.parent;
  }
  return set;
}

function treeAt(repo, hash, memo = new Map()) {
  if (hash === null) return {};
  if (memo.has(hash)) return clone(memo.get(hash));
  const commit = repo.commits[hash];
  if (!commit) throw new RepoError(`broken parent chain: unknown commit ${hash}`);
  const base = treeAt(repo, commit.parent, memo);
  let tree;
  try {
    tree = applyPatch(clone(base), commit.patch);
  } catch (err) {
    throw new RepoError(`stored history does not replay at commit ${hash}: ${err.message}`);
  }
  memo.set(hash, clone(tree));
  return tree;
}

module.exports = { RepoError, validateRepo, loadRepo, ancestors, treeAt };

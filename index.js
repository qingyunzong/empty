#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

class SemanticError extends Error {}
class UsageError extends Error {}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hashOf(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizeDepends(depends, ctx) {
  if (depends === undefined) return [];
  if (!Array.isArray(depends) || depends.some((d) => typeof d !== 'string' || d === '')) {
    throw new SemanticError(`${ctx}: depends must be an array of step ids`);
  }
  return [...new Set(depends)].sort();
}

function normalizeDuration(duration, ctx) {
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    throw new SemanticError(`${ctx}: duration must be a finite number`);
  }
  return duration;
}

function findCycle(state) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of state.keys()) color.set(id, WHITE);
  const stack = [];
  let cycle = null;
  function dfs(u) {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of state.get(u).depends) {
      if (!state.has(v)) continue;
      if (color.get(v) === GRAY) {
        cycle = stack.slice(stack.indexOf(v)).concat(v);
        return true;
      }
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    stack.pop();
    color.set(u, BLACK);
    return false;
  }
  for (const id of state.keys()) {
    if (color.get(id) === WHITE && dfs(id)) return cycle;
  }
  return null;
}

function validateState(state) {
  for (const [id, step] of state) {
    for (const dep of step.depends) {
      if (!state.has(dep)) {
        throw new SemanticError(`step "${id}" depends on missing step "${dep}"`);
      }
    }
  }
  const cycle = findCycle(state);
  if (cycle) throw new SemanticError(`dependency cycle detected: ${cycle.join(' -> ')}`);
}

function applyPatch(state, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SemanticError('patch must be an object');
  }
  for (const key of Object.keys(patch)) {
    if (!['add', 'update', 'delete'].includes(key)) {
      throw new SemanticError(`unknown patch operation: "${key}"`);
    }
  }
  const dels = patch.delete === undefined ? [] : patch.delete;
  const updates = patch.update === undefined ? [] : patch.update;
  const adds = patch.add === undefined ? [] : patch.add;
  if (!Array.isArray(dels) || !Array.isArray(updates) || !Array.isArray(adds)) {
    throw new SemanticError('patch add/update/delete must be arrays');
  }
  const next = new Map(state);
  for (const id of dels) {
    if (typeof id !== 'string') throw new SemanticError('delete: entries must be step ids');
    if (!next.has(id)) throw new SemanticError(`delete: step not found: "${id}"`);
    next.delete(id);
  }
  for (const u of updates) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string') {
      throw new SemanticError('update: each entry must be an object with an id');
    }
    const cur = next.get(u.id);
    if (!cur) throw new SemanticError(`update: step not found: "${u.id}"`);
    next.set(u.id, {
      depends: u.depends === undefined ? cur.depends : normalizeDepends(u.depends, 'update'),
      duration: u.duration === undefined ? cur.duration : normalizeDuration(u.duration, 'update'),
    });
  }
  const seen = new Set();
  for (const a of adds) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || a.id === '') {
      throw new SemanticError('add: each entry must be an object with an id');
    }
    if (next.has(a.id) || seen.has(a.id)) {
      throw new SemanticError(`add: step already exists: "${a.id}"`);
    }
    seen.add(a.id);
    next.set(a.id, {
      depends: normalizeDepends(a.depends, 'add'),
      duration: normalizeDuration(a.duration, 'add'),
    });
  }
  validateState(next);
  return next;
}

function stateToObject(state) {
  const out = {};
  for (const [id, step] of state) out[id] = { depends: step.depends, duration: step.duration };
  return out;
}

function stateHashOf(state) {
  return hashOf(stateToObject(state));
}

function commitHashOf(prevHash, stateHash, patch) {
  return hashOf({ prevHash, stateHash, patch });
}

function makeCommit(prevHash, patch, state, sealed) {
  const stateHash = stateHashOf(state);
  const commit = { hash: commitHashOf(prevHash, stateHash, patch), prevHash, stateHash, patch };
  if (sealed) commit.sealed = true;
  return commit;
}

function replayCommits(commits) {
  let state = new Map();
  let prevHash = null;
  const states = [];
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const at = c && typeof c === 'object' && typeof c.hash === 'string' ? c.hash : i;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return { ok: false, failsAt: at, reason: 'commit must be an object' };
    }
    if (c.prevHash !== prevHash) {
      return { ok: false, failsAt: at, reason: `prevHash mismatch: expected ${JSON.stringify(prevHash)}` };
    }
    let next;
    try {
      next = applyPatch(state, c.patch);
    } catch (err) {
      return { ok: false, failsAt: at, reason: err.message };
    }
    const stateHash = stateHashOf(next);
    if (c.stateHash !== stateHash) {
      return { ok: false, failsAt: at, reason: 'stateHash mismatch' };
    }
    if (c.hash !== commitHashOf(c.prevHash, c.stateHash, c.patch)) {
      return { ok: false, failsAt: at, reason: 'hash mismatch' };
    }
    state = next;
    prevHash = c.hash;
    states.push(state);
  }
  return { ok: true, states, tip: prevHash };
}

function validateRepoShape(repo) {
  if (!repo || typeof repo !== 'object' || Array.isArray(repo) || !Array.isArray(repo.commits)) {
    throw new UsageError('repo file must be a JSON object with a "commits" array');
  }
}

function play(repo) {
  validateRepoShape(repo);
  const result = replayCommits(repo.commits);
  if (!result.ok) return result;
  const finalState = result.states.length ? result.states[result.states.length - 1] : new Map();
  return {
    ok: true,
    commits: repo.commits.length,
    tip: result.tip,
    stateHash: stateHashOf(finalState),
    state: stateToObject(finalState),
  };
}

function rewrite(repo, targetHash, newPatch) {
  validateRepoShape(repo);
  const commits = repo.commits;
  const idx = commits.findIndex((c) => c && typeof c === 'object' && c.hash === targetHash);
  if (idx === -1) return { ok: false, failsAt: targetHash, reason: 'commit not found' };
  const prefix = replayCommits(commits.slice(0, idx));
  if (!prefix.ok) return prefix;
  for (let j = idx; j < commits.length; j++) {
    if (commits[j] && commits[j].sealed) {
      return { ok: false, failsAt: commits[j].hash, reason: 'commit is sealed' };
    }
  }
  let state = idx === 0 ? new Map() : prefix.states[idx - 1];
  let prevHash = idx === 0 ? null : commits[idx - 1].hash;
  const newCommits = commits.slice(0, idx);
  const mapping = {};
  for (let j = idx; j < commits.length; j++) {
    const patch = j === idx ? newPatch : commits[j].patch;
    let next;
    try {
      next = applyPatch(state, patch);
    } catch (err) {
      return { ok: false, failsAt: commits[j].hash, reason: err.message };
    }
    const commit = makeCommit(prevHash, patch, next, commits[j].sealed);
    mapping[commits[j].hash] = commit.hash;
    newCommits.push(commit);
    state = next;
    prevHash = commit.hash;
  }
  return { ok: true, commits: newCommits, mapping };
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${file}: ${err.message}`);
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const USAGE = [
  'usage:',
  '  node index.js init    --repo r.json',
  '  node index.js commit  --repo r.json --patch p.json [--out o.json] [--seal]',
  '  node index.js play    --repo r.json',
  '  node index.js rewrite --repo r.json --commit h --patch p.json --out n.json',
].join('\n');

function requireArg(args, name) {
  if (typeof args[name] !== 'string') throw new UsageError(`missing required --${name}`);
  return args[name];
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'init': {
      const repoFile = requireArg(args, 'repo');
      atomicWrite(repoFile, JSON.stringify({ version: 1, commits: [] }, null, 2) + '\n');
      console.log(JSON.stringify({ ok: true, repo: repoFile }));
      return 0;
    }
    case 'commit': {
      const repoFile = requireArg(args, 'repo');
      const patchFile = requireArg(args, 'patch');
      const repo = readJsonFile(repoFile);
      validateRepoShape(repo);
      const patch = readJsonFile(patchFile);
      const prefix = replayCommits(repo.commits);
      if (!prefix.ok) {
        console.error(JSON.stringify({ ok: false, failsAt: prefix.failsAt, reason: prefix.reason }));
        return 1;
      }
      const state = prefix.states.length ? prefix.states[prefix.states.length - 1] : new Map();
      let next;
      try {
        next = applyPatch(state, patch);
      } catch (err) {
        console.error(JSON.stringify({ ok: false, failsAt: null, reason: err.message }));
        return 1;
      }
      const commit = makeCommit(prefix.tip, patch, next, args.seal === true);
      const out = typeof args.out === 'string' ? args.out : repoFile;
      atomicWrite(out, JSON.stringify({ ...repo, commits: [...repo.commits, commit] }, null, 2) + '\n');
      console.log(JSON.stringify({ ok: true, hash: commit.hash, out }));
      return 0;
    }
    case 'play': {
      const repoFile = requireArg(args, 'repo');
      const result = play(readJsonFile(repoFile));
      if (!result.ok) {
        console.error(JSON.stringify({ ok: false, failsAt: result.failsAt, reason: result.reason }));
        return 1;
      }
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case 'rewrite': {
      const repoFile = requireArg(args, 'repo');
      const target = requireArg(args, 'commit');
      const patchFile = requireArg(args, 'patch');
      const out = requireArg(args, 'out');
      const repo = readJsonFile(repoFile);
      const newPatch = readJsonFile(patchFile);
      const result = rewrite(repo, target, newPatch);
      if (!result.ok) {
        console.error(JSON.stringify({ ok: false, failsAt: result.failsAt, reason: result.reason }));
        return 1;
      }
      atomicWrite(out, JSON.stringify({ ...repo, commits: result.commits }, null, 2) + '\n');
      console.log(JSON.stringify({ ok: true, mapping: result.mapping, out }, null, 2));
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

function cli(argv) {
  try {
    return main(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = cli(process.argv.slice(2));
}

module.exports = {
  SemanticError,
  UsageError,
  canonical,
  hashOf,
  findCycle,
  validateState,
  applyPatch,
  stateToObject,
  stateHashOf,
  commitHashOf,
  makeCommit,
  replayCommits,
  play,
  rewrite,
  atomicWrite,
  cli,
};

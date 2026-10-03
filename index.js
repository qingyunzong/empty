#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class RouteError extends Error {}
class UsageError extends Error {}

class HistoryError extends Error {
  constructor(failsAt, reason) {
    super(reason);
    this.failsAt = failsAt;
    this.reason = reason;
  }
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function stateObject(state) {
  const obj = {};
  for (const id of [...state.keys()].sort()) {
    const step = state.get(id);
    obj[id] = { depends: [...step.depends].sort(), duration: step.duration };
  }
  return obj;
}

function hashState(state) {
  return sha256hex(canonical(stateObject(state)));
}

function hashCommit(commit) {
  return sha256hex(canonical({
    prevHash: commit.prevHash ?? null,
    stateHash: commit.stateHash,
    patch: commit.patch,
  }));
}

function cloneState(state) {
  const next = new Map();
  for (const [id, step] of state) {
    next.set(id, { id, depends: [...step.depends], duration: step.duration });
  }
  return next;
}

function routeFromState(state) {
  return [...state.keys()].sort().map((id) => {
    const step = state.get(id);
    return { id, depends: [...step.depends], duration: step.duration };
  });
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validateDepends(depends, ctx) {
  if (!Array.isArray(depends)) {
    throw new RouteError(`${ctx}: depends must be an array`);
  }
  const seen = new Set();
  for (const dep of depends) {
    if (!isNonEmptyString(dep)) {
      throw new RouteError(`${ctx}: dependency ids must be non-empty strings`);
    }
    if (seen.has(dep)) {
      throw new RouteError(`${ctx}: duplicate dependency "${dep}"`);
    }
    seen.add(dep);
  }
}

function validateDuration(duration, ctx) {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    throw new RouteError(`${ctx}: duration must be a non-negative finite number`);
  }
}

function validateStepShape(step, ctx, full) {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    throw new RouteError(`${ctx}: step must be an object`);
  }
  if (!isNonEmptyString(step.id)) {
    throw new RouteError(`${ctx}: step id must be a non-empty string`);
  }
  if (full || step.depends !== undefined) {
    validateDepends(step.depends ?? [], `${ctx} step "${step.id}"`);
  }
  if (full || step.duration !== undefined) {
    validateDuration(step.duration ?? 0, `${ctx} step "${step.id}"`);
  }
}

function findCycle(state) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of state.keys()) color.set(id, WHITE);
  for (const start of state.keys()) {
    if (color.get(start) !== WHITE) continue;
    color.set(start, GRAY);
    const stack = [[start, 0]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const deps = state.get(top[0]).depends;
      if (top[1] < deps.length) {
        const dep = deps[top[1]++];
        if (!state.has(dep)) continue;
        const c = color.get(dep);
        if (c === GRAY) return true;
        if (c === WHITE) {
          color.set(dep, GRAY);
          stack.push([dep, 0]);
        }
      } else {
        color.set(top[0], BLACK);
        stack.pop();
      }
    }
  }
  return false;
}

function applyPatch(state, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RouteError('patch must be an object');
  }
  const allowed = new Set(['add', 'update', 'delete']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new RouteError(`unknown patch key "${key}"`);
  }
  const adds = patch.add ?? [];
  const updates = patch.update ?? [];
  const deletes = patch.delete ?? [];
  if (!Array.isArray(adds)) throw new RouteError('patch.add must be an array');
  if (!Array.isArray(updates)) throw new RouteError('patch.update must be an array');
  if (!Array.isArray(deletes)) throw new RouteError('patch.delete must be an array');

  const next = cloneState(state);

  for (const step of adds) {
    validateStepShape(step, 'add', true);
    if (next.has(step.id)) {
      throw new RouteError(`add: step "${step.id}" already exists`);
    }
    next.set(step.id, {
      id: step.id,
      depends: [...(step.depends ?? [])],
      duration: step.duration ?? 0,
    });
  }

  for (const upd of updates) {
    validateStepShape(upd, 'update', false);
    if (!next.has(upd.id)) {
      throw new RouteError(`update: step "${upd.id}" does not exist`);
    }
    const cur = next.get(upd.id);
    next.set(upd.id, {
      id: upd.id,
      depends: upd.depends !== undefined ? [...upd.depends] : cur.depends,
      duration: upd.duration !== undefined ? upd.duration : cur.duration,
    });
  }

  for (const id of deletes) {
    if (!isNonEmptyString(id)) {
      throw new RouteError('delete: step ids must be non-empty strings');
    }
    if (!next.has(id)) {
      throw new RouteError(`delete: step "${id}" does not exist`);
    }
    next.delete(id);
  }

  for (const step of next.values()) {
    for (const dep of step.depends) {
      if (!next.has(dep)) {
        throw new RouteError(`step "${step.id}" depends on missing step "${dep}"`);
      }
    }
  }
  if (findCycle(next)) {
    throw new RouteError('dependency cycle detected');
  }
  return next;
}

function commitLabel(c, i) {
  if (c && typeof c.hash === 'string') return c.hash;
  return `#${i}`;
}

function replayPrefix(commits, end) {
  let state = new Map();
  let prevHash = null;
  for (let i = 0; i < end; i++) {
    const c = commits[i];
    const at = commitLabel(c, i);
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new HistoryError(at, 'commit must be an object');
    }
    const ph = c.prevHash ?? null;
    if (ph !== prevHash) {
      throw new HistoryError(at, `prevHash mismatch: expected ${prevHash === null ? 'null' : prevHash}, got ${ph === null ? 'null' : ph}`);
    }
    let next;
    try {
      next = applyPatch(state, c.patch);
    } catch (e) {
      throw new HistoryError(at, e.message);
    }
    const stateHash = hashState(next);
    if (c.stateHash !== stateHash) {
      throw new HistoryError(at, 'stateHash mismatch');
    }
    const hash = hashCommit({ prevHash: ph, stateHash: c.stateHash, patch: c.patch });
    if (c.hash !== hash) {
      throw new HistoryError(at, 'hash mismatch');
    }
    state = next;
    prevHash = c.hash;
  }
  return { state, prevHash };
}

function play(commits) {
  if (!Array.isArray(commits)) {
    throw new UsageError('repo.commits must be an array');
  }
  const { state } = replayPrefix(commits, commits.length);
  return routeFromState(state);
}

function findCommitIndex(commits, ref) {
  const exact = commits.findIndex((c) => c && c.hash === ref);
  if (exact !== -1) return exact;
  const matches = [];
  commits.forEach((c, i) => {
    if (c && typeof c.hash === 'string' && c.hash.startsWith(ref)) matches.push(i);
  });
  return matches.length === 1 ? matches[0] : -1;
}

function rewrite(commits, ref, newPatch) {
  if (!Array.isArray(commits)) {
    throw new UsageError('repo.commits must be an array');
  }
  const index = findCommitIndex(commits, ref);
  if (index === -1) {
    throw new HistoryError(null, `commit "${ref}" not found`);
  }
  for (let i = index; i < commits.length; i++) {
    if (commits[i] && commits[i].sealed === true) {
      throw new HistoryError(commitLabel(commits[i], i), 'commit is sealed and cannot be rewritten');
    }
  }

  const { state: baseState, prevHash: basePrev } = replayPrefix(commits, index);
  const out = commits.slice(0, index).map((c) => ({ ...c }));
  const mapping = {};
  let state = baseState;
  let prevHash = basePrev;

  for (let i = index; i < commits.length; i++) {
    const old = commits[i];
    const at = commitLabel(old, i);
    const patch = i === index ? newPatch : old.patch;
    let next;
    try {
      next = applyPatch(state, patch);
    } catch (e) {
      throw new HistoryError(at, e.message);
    }
    state = next;
    const stateHash = hashState(state);
    const draft = { prevHash, stateHash, patch };
    const hash = hashCommit(draft);
    const commit = { ...old, hash, prevHash, stateHash, patch };
    delete commit.sealed;
    out.push(commit);
    mapping[at] = hash;
    prevHash = hash;
  }
  return { commits: out, mapping };
}

function readJSONFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(`cannot read file: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`invalid JSON in ${file}: ${e.message}`);
  }
}

function loadRepo(file) {
  const repo = readJSONFile(file);
  if (repo === null || typeof repo !== 'object' || Array.isArray(repo) || !Array.isArray(repo.commits)) {
    throw new UsageError(`repo file ${file} must be a JSON object with a "commits" array`);
  }
  return repo;
}

function atomicWriteJSON(file, value) {
  const dir = path.dirname(path.resolve(file));
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${path.basename(file)}`);
  const data = JSON.stringify(value, null, 2) + '\n';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw new UsageError(`cannot write file ${file}: ${e.message}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new UsageError(`unexpected argument: ${a}`);
    }
    const key = a.slice(2);
    if (key.length === 0) throw new UsageError('empty flag');
    if (i + 1 >= argv.length) {
      throw new UsageError(`missing value for --${key}`);
    }
    args[key] = argv[++i];
  }
  return args;
}

const USAGE = [
  'usage:',
  '  node index.js play --repo <repo.json>',
  '  node index.js rewrite --repo <repo.json> --commit <hash> --patch <patch.json> --out <out.json>',
].join('\n');

function main(argv, io) {
  const [cmd, ...rest] = argv;
  if (cmd === 'play') {
    const args = parseArgs(rest);
    if (!args.repo) throw new UsageError('play requires --repo');
    const repo = loadRepo(args.repo);
    const route = play(repo.commits);
    io.stdout(JSON.stringify({ ok: true, route }) + '\n');
    return 0;
  }
  if (cmd === 'rewrite') {
    const args = parseArgs(rest);
    for (const k of ['repo', 'commit', 'patch', 'out']) {
      if (!args[k]) throw new UsageError(`rewrite requires --${k}`);
    }
    const repo = loadRepo(args.repo);
    const newPatch = readJSONFile(args.patch);
    const { commits, mapping } = rewrite(repo.commits, args.commit, newPatch);
    const nextRepo = { ...repo, commits };
    atomicWriteJSON(args.out, nextRepo);
    io.stdout(JSON.stringify({
      ok: true,
      mapping,
      head: commits.length > 0 ? commits[commits.length - 1].hash : null,
    }) + '\n');
    return 0;
  }
  throw new UsageError(cmd === undefined ? USAGE : `unknown command "${cmd}"\n${USAGE}`);
}

const defaultIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

function runCli(argv, io = defaultIo) {
  try {
    return main(argv, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(String(e.message) + '\n');
      return 2;
    }
    if (e instanceof HistoryError) {
      io.stderr(JSON.stringify({ failsAt: e.failsAt, reason: e.reason }) + '\n');
      return 1;
    }
    io.stderr(String((e && e.stack) || e) + '\n');
    return 2;
  }
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}

module.exports = {
  RouteError,
  UsageError,
  HistoryError,
  canonical,
  sha256hex,
  hashState,
  hashCommit,
  cloneState,
  routeFromState,
  findCycle,
  applyPatch,
  replayPrefix,
  play,
  rewrite,
  atomicWriteJSON,
  runCli,
};

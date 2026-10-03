'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../index.js');

const CLI = path.join(__dirname, '..', 'index.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'route-test-'));
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = lib.runCli(args, {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
  });
  return { status, stdout, stderr };
}

// Build a fully consistent commit chain from a list of patches.
function buildHistory(patches, sealedIdx = []) {
  const commits = [];
  let state = new Map();
  let prevHash = null;
  patches.forEach((patch, i) => {
    state = lib.applyPatch(state, patch);
    const stateHash = lib.hashState(state);
    const hash = lib.hashCommit({ prevHash, stateHash, patch });
    const commit = { hash, prevHash, stateHash, patch };
    if (sealedIdx.includes(i)) commit.sealed = true;
    commits.push(commit);
    prevHash = hash;
  });
  return commits;
}

// Forge a commit whose patch is semantically invalid; hashes are computed
// over the (unreachable) post-state so prevHash/hash links stay intact and
// the failure must surface at patch application time.
function forgeInvalidCommit(prevHash, patch, fakeState) {
  const stateHash = lib.hashState(fakeState);
  const hash = lib.hashCommit({ prevHash, stateHash, patch });
  return { hash, prevHash, stateHash, patch };
}

const LEGAL_PATCHES = [
  { add: [{ id: 'cut', depends: [], duration: 2 }, { id: 'bend', depends: ['cut'], duration: 3 }] },
  { add: [{ id: 'weld', depends: ['cut', 'bend'], duration: 4 }, { id: 'paint', depends: [], duration: 1 }] },
  { update: [{ id: 'paint', depends: ['weld'], duration: 5 }] },
  { delete: ['paint'] },
  { update: [{ id: 'weld', duration: 6 }] },
];

test('play: legal route with add/update/delete and deps replays successfully', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const commits = buildHistory(LEGAL_PATCHES);
  writeJSON(repoFile, { commits });

  const res = runCli(['play', '--repo', repoFile]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.route, [
    { id: 'bend', depends: ['cut'], duration: 3 },
    { id: 'cut', depends: [], duration: 2 },
    { id: 'weld', depends: ['cut', 'bend'], duration: 6 },
  ]);
});

test('rewrite: replacing a middle patch rehashes successors and yields the correct final graph', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  const commits = buildHistory(LEGAL_PATCHES);
  writeJSON(repoFile, { commits });

  const newPatch = { add: [{ id: 'weld', depends: ['cut'], duration: 4 }, { id: 'paint', depends: [], duration: 1 }] };
  const patchFile = path.join(dir, 'p.json');
  writeJSON(patchFile, newPatch);

  const res = runCli(['rewrite', '--repo', repoFile, '--commit', commits[1].hash, '--patch', patchFile, '--out', outFile]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);

  const nextRepo = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  // Prefix untouched.
  assert.equal(nextRepo.commits[0].hash, commits[0].hash);
  assert.deepEqual(nextRepo.commits[0], commits[0]);
  // Rewritten commit and all successors got new hashes.
  for (let i = 1; i < commits.length; i++) {
    assert.notEqual(nextRepo.commits[i].hash, commits[i].hash);
    assert.equal(out.mapping[commits[i].hash], nextRepo.commits[i].hash);
  }
  assert.equal(Object.keys(out.mapping).length, commits.length - 1);
  assert.equal(out.head, nextRepo.commits[nextRepo.commits.length - 1].hash);
  // Hash chain is consistent.
  assert.equal(nextRepo.commits[1].prevHash, commits[0].hash);
  for (let i = 2; i < nextRepo.commits.length; i++) {
    assert.equal(nextRepo.commits[i].prevHash, nextRepo.commits[i - 1].hash);
  }
  // Final graph equals replaying the rewritten patch sequence.
  const expected = lib.play(lib.rewrite(commits, commits[1].hash, newPatch).commits);
  const actual = lib.play(nextRepo.commits);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual, [
    { id: 'bend', depends: ['cut'], duration: 3 },
    { id: 'cut', depends: [], duration: 2 },
    { id: 'weld', depends: ['cut'], duration: 6 },
  ]);
  // Original repo file untouched.
  assert.deepEqual(JSON.parse(fs.readFileSync(repoFile, 'utf8')).commits, commits);
});

test('play: missing dependency stops at the first failing commit and leaves history unchanged', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const good = buildHistory(LEGAL_PATCHES.slice(0, 2));
  const bad = forgeInvalidCommit(good[1].hash, { add: [{ id: 'x', depends: ['ghost'], duration: 1 }] }, new Map());
  const after = forgeInvalidCommit(bad.hash, { add: [{ id: 'y', depends: [], duration: 1 }] }, new Map());
  const commits = [...good, bad, after];
  writeJSON(repoFile, { commits });
  const before = fs.readFileSync(repoFile, 'utf8');

  const res = runCli(['play', '--repo', repoFile]);
  assert.equal(res.status, 1, res.stderr);
  const err = JSON.parse(res.stderr);
  assert.equal(err.failsAt, bad.hash);
  assert.match(err.reason, /missing step "ghost"/);
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before);
});

test('play: dependency cycle stops at the first failing commit and leaves history unchanged', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const good = buildHistory(LEGAL_PATCHES.slice(0, 2));
  const cyclic = forgeInvalidCommit(good[1].hash, {
    update: [
      { id: 'cut', depends: ['weld'] },
      { id: 'weld', depends: ['cut'] },
    ],
  }, new Map());
  const commits = [...good, cyclic];
  writeJSON(repoFile, { commits });
  const before = fs.readFileSync(repoFile, 'utf8');

  const res = runCli(['play', '--repo', repoFile]);
  assert.equal(res.status, 1, res.stderr);
  const err = JSON.parse(res.stderr);
  assert.equal(err.failsAt, cyclic.hash);
  assert.match(err.reason, /cycle/);
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before);
});

test('rewrite: failure after the rewrite point lands nothing on disk', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  // Rewriting commit 1 to skip adding 'paint' makes commit 2 (update paint)
  // the first failure point, so the rewrite must abort atomically.
  const commits = buildHistory(LEGAL_PATCHES);
  writeJSON(repoFile, { commits });
  const before = fs.readFileSync(repoFile, 'utf8');

  const newPatch = { add: [{ id: 'weld', depends: ['cut', 'bend'], duration: 4 }] };
  const patchFile = path.join(dir, 'p.json');
  writeJSON(patchFile, newPatch);

  const res = runCli(['rewrite', '--repo', repoFile, '--commit', commits[1].hash, '--patch', patchFile, '--out', outFile]);
  assert.equal(res.status, 1, res.stderr);
  const err = JSON.parse(res.stderr);
  assert.equal(err.failsAt, commits[2].hash);
  assert.match(err.reason, /update: step "paint" does not exist/);
  assert.equal(fs.existsSync(outFile), false);
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before);
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-')), []);
});

test('rewrite: sealed commits and their hashes cannot be rewritten', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  const commits = buildHistory(LEGAL_PATCHES, [2]);
  writeJSON(repoFile, { commits });
  const before = fs.readFileSync(repoFile, 'utf8');
  const patchFile = path.join(dir, 'p.json');
  writeJSON(patchFile, { update: [{ id: 'cut', duration: 9 }] });

  // Rewriting the sealed commit itself is rejected.
  let res = runCli(['rewrite', '--repo', repoFile, '--commit', commits[2].hash, '--patch', patchFile, '--out', outFile]);
  assert.equal(res.status, 1, res.stderr);
  assert.equal(JSON.parse(res.stderr).failsAt, commits[2].hash);
  assert.match(JSON.parse(res.stderr).reason, /sealed/);

  // Rewriting an ancestor (which would rehash the sealed commit) is rejected too.
  res = runCli(['rewrite', '--repo', repoFile, '--commit', commits[0].hash, '--patch', patchFile, '--out', outFile]);
  assert.equal(res.status, 1, res.stderr);
  assert.match(JSON.parse(res.stderr).reason, /sealed/);

  assert.equal(fs.existsSync(outFile), false);
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before);
});

test('play: tampered hash chain is detected', () => {
  const dir = tmpdir();
  const commits = buildHistory(LEGAL_PATCHES);

  const repoFile = path.join(dir, 'r.json');
  const tampered = commits.map((c) => ({ ...c }));
  tampered[2] = { ...tampered[2], stateHash: '0'.repeat(64) };
  writeJSON(repoFile, { commits: tampered });
  let res = runCli(['play', '--repo', repoFile]);
  assert.equal(res.status, 1);
  let err = JSON.parse(res.stderr);
  assert.equal(err.failsAt, tampered[2].hash);
  assert.match(err.reason, /stateHash mismatch/);

  const tampered2 = commits.map((c) => ({ ...c }));
  tampered2[3] = { ...tampered2[3], prevHash: 'f'.repeat(64) };
  writeJSON(repoFile, { commits: tampered2 });
  res = runCli(['play', '--repo', repoFile]);
  assert.equal(res.status, 1);
  err = JSON.parse(res.stderr);
  assert.equal(err.failsAt, tampered2[3].hash);
  assert.match(err.reason, /prevHash mismatch/);
});

test('cli: usage errors and JSON errors exit with code 2', () => {
  const dir = tmpdir();
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['bogus']).status, 2);
  assert.equal(runCli(['play']).status, 2);
  assert.equal(runCli(['play', '--repo', path.join(dir, 'missing.json')]).status, 2);

  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{not json');
  assert.equal(runCli(['play', '--repo', badJson]).status, 2);

  const notRepo = path.join(dir, 'arr.json');
  writeJSON(notRepo, [1, 2, 3]);
  assert.equal(runCli(['play', '--repo', notRepo]).status, 2);

  const repoFile = path.join(dir, 'r.json');
  writeJSON(repoFile, { commits: buildHistory(LEGAL_PATCHES.slice(0, 1)) });
  assert.equal(runCli(['rewrite', '--repo', repoFile]).status, 2);
  // Unknown extra flags are tolerated and do not affect the exit code.
  assert.equal(runCli(['play', '--repo', repoFile, '--nope', 'x']).status, 0);
});

test('rewrite: unknown commit hash is a semantic failure (exit 1)', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  const patchFile = path.join(dir, 'p.json');
  writeJSON(repoFile, { commits: buildHistory(LEGAL_PATCHES.slice(0, 2)) });
  writeJSON(patchFile, { add: [] });
  const res = runCli(['rewrite', '--repo', repoFile, '--commit', 'deadbeef', '--patch', patchFile, '--out', outFile]);
  assert.equal(res.status, 1);
  assert.match(JSON.parse(res.stderr).reason, /not found/);
  assert.equal(fs.existsSync(outFile), false);
});

// --- Brute-force cross-check of cycle detection ---------------------------

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) {
      out.push([items[i], ...perm]);
    }
  }
  return out;
}

// A graph has a topological order iff it is acyclic.
function hasTopologicalOrder(ids, edges) {
  for (const perm of permutations(ids)) {
    const pos = new Map(perm.map((id, i) => [id, i]));
    let ok = true;
    for (const [from, to] of edges) {
      if (pos.get(to) >= pos.get(from)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

test('cycle detection matches brute-force permutation check for all digraphs on <=4 steps', () => {
  for (let n = 1; n <= 4; n++) {
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    const pairs = [];
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a !== b) pairs.push([ids[a], ids[b]]);
      }
    }
    const total = 1 << pairs.length;
    for (let mask = 0; mask < total; mask++) {
      const edges = pairs.filter((_, i) => (mask >> i) & 1);
      const state = new Map(ids.map((id) => [id, {
        id,
        depends: edges.filter(([from]) => from === id).map(([, to]) => to),
        duration: 1,
      }]));
      const dfsSays = lib.findCycle(state);
      const bruteSays = !hasTopologicalOrder(ids, edges);
      assert.equal(dfsSays, bruteSays, `n=${n} mask=${mask} edges=${JSON.stringify(edges)}`);
    }
  }
});

test('applyPatch: rejects duplicates, unknown steps and self-cycles', () => {
  const base = lib.applyPatch(new Map(), { add: [{ id: 'a', depends: [], duration: 1 }] });
  assert.throws(() => lib.applyPatch(base, { add: [{ id: 'a', depends: [], duration: 1 }] }), /already exists/);
  assert.throws(() => lib.applyPatch(base, { update: [{ id: 'b', duration: 1 }] }), /does not exist/);
  assert.throws(() => lib.applyPatch(base, { delete: ['b'] }), /does not exist/);
  assert.throws(() => lib.applyPatch(base, { update: [{ id: 'a', depends: ['a'] }] }), /cycle/);
  assert.throws(() => lib.applyPatch(base, { add: [{ id: 'b', depends: ['b'], duration: 1 }] }), /cycle|missing/);
  assert.throws(() => lib.applyPatch(base, { add: [{ id: 'b', depends: [], duration: -1 }] }), /duration/);
  assert.throws(() => lib.applyPatch(base, { frobnicate: [] }), /unknown patch key/);
});

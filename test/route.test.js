'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../index.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
}

function buildCommits(patches, sealedIdx = -1) {
  const commits = [];
  let state = new Map();
  let prevHash = null;
  patches.forEach((patch, i) => {
    state = lib.applyPatch(state, patch);
    const commit = lib.makeCommit(prevHash, patch, state, i === sealedIdx);
    commits.push(commit);
    prevHash = commit.hash;
  });
  return commits;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function runCli(args) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  let status;
  try {
    status = lib.cli(args);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('acceptance 1: add/update/delete with dependencies replays successfully', () => {
  const patches = [
    { add: [{ id: 'cut', duration: 2 }, { id: 'bend', duration: 3 }] },
    { add: [{ id: 'weld', depends: ['cut', 'bend'], duration: 5 }] },
    { update: [{ id: 'bend', duration: 4 }] },
    { add: [{ id: 'paint', depends: ['weld'], duration: 1 }] },
    { delete: ['paint'] },
  ];
  const repo = { version: 1, commits: buildCommits(patches) };
  const result = lib.play(repo);
  assert.equal(result.ok, true);
  assert.equal(result.commits, 5);
  assert.deepEqual(result.state, {
    cut: { depends: [], duration: 2 },
    bend: { depends: [], duration: 4 },
    weld: { depends: ['bend', 'cut'], duration: 5 },
  });

  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  writeJson(repoFile, repo);
  const proc = runCli(['play', '--repo', repoFile]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).ok, true);
});

test('acceptance 2: rewriting a middle patch rehashes successors and yields correct graph', () => {
  const patches = [
    { add: [{ id: 'a', duration: 1 }, { id: 'b', duration: 2 }] },
    { add: [{ id: 'c', depends: ['a'], duration: 3 }] },
    { add: [{ id: 'd', depends: ['c'], duration: 4 }] },
    { update: [{ id: 'd', duration: 9 }] },
  ];
  const repo = { version: 1, commits: buildCommits(patches) };
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  const patchFile = path.join(dir, 'p.json');
  writeJson(repoFile, repo);
  const before = fs.readFileSync(repoFile, 'utf8');
  const newPatch = { add: [{ id: 'c', depends: ['a', 'b'], duration: 7 }] };
  writeJson(patchFile, newPatch);

  const target = repo.commits[1].hash;
  const proc = runCli(['rewrite', '--repo', repoFile, '--commit', target, '--patch', patchFile, '--out', outFile]);
  assert.equal(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.equal(report.ok, true);

  assert.deepEqual(Object.keys(report.mapping).sort(), repo.commits.slice(1).map((c) => c.hash).sort());
  for (const [oldHash, newHash] of Object.entries(report.mapping)) {
    assert.notEqual(oldHash, newHash);
  }

  assert.equal(fs.readFileSync(repoFile, 'utf8'), before, 'original repo must be untouched');

  const rewritten = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(rewritten.commits[0].hash, repo.commits[0].hash, 'prefix commit keeps its hash');
  for (let i = 1; i < repo.commits.length; i++) {
    assert.equal(rewritten.commits[i].hash, report.mapping[repo.commits[i].hash]);
    assert.equal(rewritten.commits[i].prevHash, rewritten.commits[i - 1].hash);
  }

  const replayed = lib.play(rewritten);
  assert.equal(replayed.ok, true);
  assert.deepEqual(replayed.state, {
    a: { depends: [], duration: 1 },
    b: { depends: [], duration: 2 },
    c: { depends: ['a', 'b'], duration: 7 },
    d: { depends: ['c'], duration: 9 },
  });
});

test('acceptance 3: replay stops at first failing commit and history stays unchanged', () => {
  const good = buildCommits([
    { add: [{ id: 'a', duration: 1 }] },
    { add: [{ id: 'b', depends: ['a'], duration: 2 }] },
  ]);

  const badDepPatch = { add: [{ id: 'c', depends: ['ghost'], duration: 1 }] };
  const badDepCommit = {
    hash: lib.commitHashOf(good[1].hash, 'x', badDepPatch),
    prevHash: good[1].hash,
    stateHash: 'x',
    patch: badDepPatch,
  };
  const repoMissing = { version: 1, commits: [...good, badDepCommit] };
  const r1 = lib.play(repoMissing);
  assert.equal(r1.ok, false);
  assert.equal(r1.failsAt, badDepCommit.hash);
  assert.match(r1.reason, /missing step "ghost"/);

  const cyclePatch = { add: [{ id: 'x', depends: ['y'], duration: 1 }, { id: 'y', depends: ['x'], duration: 1 }] };
  const cycleCommit = {
    hash: lib.commitHashOf(good[1].hash, 'y', cyclePatch),
    prevHash: good[1].hash,
    stateHash: 'y',
    patch: cyclePatch,
  };
  const repoCycle = { version: 1, commits: [...good, cycleCommit] };
  const r2 = lib.play(repoCycle);
  assert.equal(r2.ok, false);
  assert.equal(r2.failsAt, cycleCommit.hash);
  assert.match(r2.reason, /cycle/);

  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  writeJson(repoFile, repoMissing);
  const before = fs.readFileSync(repoFile, 'utf8');
  const proc = runCli(['play', '--repo', repoFile]);
  assert.equal(proc.status, 1);
  assert.equal(JSON.parse(proc.stderr).failsAt, badDepCommit.hash);
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before, 'repo file must be unchanged');
});

test('rewrite failure after the target lands nothing and reports first failing point', () => {
  const patches = [
    { add: [{ id: 'a', duration: 1 }] },
    { add: [{ id: 'b', depends: ['a'], duration: 2 }] },
    { add: [{ id: 'c', depends: ['b'], duration: 3 }] },
  ];
  const repo = { version: 1, commits: buildCommits(patches) };
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  const patchFile = path.join(dir, 'p.json');
  writeJson(repoFile, repo);
  const before = fs.readFileSync(repoFile, 'utf8');
  writeJson(patchFile, { add: [{ id: 'z', duration: 5 }] });

  const proc = runCli([
    'rewrite', '--repo', repoFile,
    '--commit', repo.commits[0].hash,
    '--patch', patchFile,
    '--out', outFile,
  ]);
  assert.equal(proc.status, 1);
  const report = JSON.parse(proc.stderr);
  assert.equal(report.ok, false);
  assert.equal(report.failsAt, repo.commits[1].hash, 'first failure is the successor needing "a"');
  assert.match(report.reason, /missing step "a"/);
  assert.equal(fs.existsSync(outFile), false, 'no output may be written on failure');
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before, 'original repo must be unchanged');
});

test('sealed commits cannot be rewritten', () => {
  const patches = [
    { add: [{ id: 'a', duration: 1 }] },
    { add: [{ id: 'b', depends: ['a'], duration: 2 }] },
    { add: [{ id: 'c', depends: ['b'], duration: 3 }] },
  ];
  const dir = tmpdir();

  const repoSealedTarget = { version: 1, commits: buildCommits(patches, 1) };
  const f1 = path.join(dir, 'r1.json');
  writeJson(f1, repoSealedTarget);
  const before1 = fs.readFileSync(f1, 'utf8');
  const p1 = path.join(dir, 'p1.json');
  writeJson(p1, { add: [{ id: 'b2', duration: 1 }] });
  const proc1 = runCli(['rewrite', '--repo', f1, '--commit', repoSealedTarget.commits[1].hash, '--patch', p1, '--out', path.join(dir, 'n1.json')]);
  assert.equal(proc1.status, 1);
  assert.match(JSON.parse(proc1.stderr).reason, /sealed/);
  assert.equal(fs.readFileSync(f1, 'utf8'), before1);
  assert.equal(fs.existsSync(path.join(dir, 'n1.json')), false);

  const repoSealedLater = { version: 1, commits: buildCommits(patches, 2) };
  const f2 = path.join(dir, 'r2.json');
  writeJson(f2, repoSealedLater);
  const before2 = fs.readFileSync(f2, 'utf8');
  const proc2 = runCli(['rewrite', '--repo', f2, '--commit', repoSealedLater.commits[0].hash, '--patch', p1, '--out', path.join(dir, 'n2.json')]);
  assert.equal(proc2.status, 1);
  assert.match(JSON.parse(proc2.stderr).reason, /sealed/);
  assert.equal(fs.readFileSync(f2, 'utf8'), before2);
  assert.equal(fs.existsSync(path.join(dir, 'n2.json')), false);
});

test('exit codes: usage and JSON errors are 2, semantic conflicts are 1', () => {
  const dir = tmpdir();
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['bogus']).status, 2);
  assert.equal(runCli(['play', '--repo', path.join(dir, 'missing.json')]).status, 2);

  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{not json');
  assert.equal(runCli(['play', '--repo', badJson]).status, 2);

  const repo = { version: 1, commits: buildCommits([{ add: [{ id: 'a', duration: 1 }] }]) };
  const repoFile = path.join(dir, 'r.json');
  writeJson(repoFile, repo);
  const patchFile = path.join(dir, 'p.json');
  writeJson(patchFile, { add: [{ id: 'b', duration: 1 }] });
  const proc = runCli(['rewrite', '--repo', repoFile, '--commit', 'deadbeef', '--patch', patchFile, '--out', path.join(dir, 'n.json')]);
  assert.equal(proc.status, 1);
  assert.match(JSON.parse(proc.stderr).reason, /commit not found/);
});

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

function referenceHasCycle(nodes, edges) {
  for (const perm of permutations(nodes)) {
    const pos = new Map(perm.map((id, i) => [id, i]));
    let forward = true;
    for (const [u, v] of edges) {
      if (pos.get(u) >= pos.get(v)) {
        forward = false;
        break;
      }
    }
    if (forward) return false;
  }
  return true;
}

test('cross-check: DFS cycle detection matches permutation enumeration for <=4 steps', () => {
  for (let n = 1; n <= 4; n++) {
    const nodes = Array.from({ length: n }, (_, i) => `s${i}`);
    const allEdges = [];
    for (const u of nodes) for (const v of nodes) allEdges.push([u, v]);
    const total = 1 << allEdges.length;
    for (let mask = 0; mask < total; mask++) {
      const edges = allEdges.filter((_, i) => mask & (1 << i));
      const state = new Map();
      for (const id of nodes) {
        state.set(id, { depends: edges.filter(([v]) => v === id).map(([, d]) => d), duration: 1 });
      }
      const dfsCycle = lib.findCycle(state) !== null;
      const refCycle = referenceHasCycle(nodes, edges.map(([v, d]) => [d, v]));
      assert.equal(dfsCycle, refCycle, `mismatch for n=${n} edges=${JSON.stringify(edges)}`);
    }
  }
});

test('cross-check: every permutation of <=4 steps builds a replayable route', () => {
  for (let n = 1; n <= 4; n++) {
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    for (const perm of permutations(ids)) {
      const patch = {
        add: perm.map((id, i) => ({
          id,
          depends: i === 0 ? [] : [perm[i - 1]],
          duration: i + 1,
        })),
      };
      const repo = { version: 1, commits: buildCommits([patch]) };
      const result = lib.play(repo);
      assert.equal(result.ok, true, `permutation ${perm} must replay`);
      assert.deepEqual(Object.keys(result.state).sort(), ids.slice().sort());
    }
  }
});

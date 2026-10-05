'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { computeStates } = require('../lib/repo');
const { effectiveAt, leafEffectiveThresholds } = require('../lib/tree');
const { makeRepo, makeBranchRepo } = require('./helpers');

const CLI = path.join(__dirname, '..', 'index.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alert-vcs-'));
}

test('CLI squash: exit 0, writes repo with mapping and matching stateHash', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  fs.writeFileSync(repoFile, JSON.stringify(makeRepo()));

  const result = run(['squash', '--repo', repoFile, '--from', 'g', '--to', 'c', '--out', outFile]);
  assert.equal(result.status, 0, result.stderr);

  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(out.commits.length, 3);
  const squashedHash = out.commits[1].hash;
  assert.match(squashedHash, /^sq-/);
  assert.deepEqual(out.mapping, {
    g: 'g', a: squashedHash, b: squashedHash, c: squashedHash, d: 'd',
  });

  const oldStates = computeStates(makeRepo());
  const newStates = computeStates(out);
  assert.equal(newStates.get('d').stateHash, oldStates.get('d').stateHash);
  assert.deepEqual(
    leafEffectiveThresholds(newStates.get('d').tree),
    leafEffectiveThresholds(oldStates.get('d').tree),
  );
});

test('CLI squash: unknown commit hash exits 2 and writes nothing', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  fs.writeFileSync(repoFile, JSON.stringify(makeRepo()));

  const result = run(['squash', '--repo', repoFile, '--from', 'g', '--to', 'zz', '--out', outFile]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown commit/);
  assert.equal(fs.existsSync(outFile), false);
});

test('CLI squash: sealed commit inside range exits 2', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  const repo = makeRepo();
  repo.commits[1].sealed = true; // commit a sealed, inside (g, c]
  fs.writeFileSync(repoFile, JSON.stringify(repo));

  const result = run(['squash', '--repo', repoFile, '--from', 'g', '--to', 'c', '--out', outFile]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sealed/);
  assert.equal(fs.existsSync(outFile), false);
});

test('CLI merge: structural conflict exits 1', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  fs.writeFileSync(repoFile, JSON.stringify(makeBranchRepo(
    { delete: ['/a'] },
    { set: { '/a/b': { temp: 99 } } },
  )));

  const result = run(['merge', '--repo', repoFile, '--base', 'm0', '--left', 'l1', '--right', 'r1', '--out', outFile]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflict/);
  assert.equal(fs.existsSync(outFile), false);
});

test('CLI merge: disjoint overrides exit 0 and inheritance holds', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  fs.writeFileSync(repoFile, JSON.stringify(makeBranchRepo(
    { set: { '/a': { hum: 25 } } },
    { set: { '/a/b': { press: 100 } } },
  )));

  const result = run(['merge', '--repo', repoFile, '--base', 'm0', '--left', 'l1', '--right', 'r1', '--out', outFile]);
  assert.equal(result.status, 0, result.stderr);

  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const mergeCommit = out.commits[out.commits.length - 1];
  assert.deepEqual(mergeCommit.parents, ['l1', 'r1']);
  assert.equal(out.head, mergeCommit.hash);
  const states = computeStates(out);
  const mergedTree = states.get(mergeCommit.hash).tree;
  assert.deepEqual(effectiveAt(mergedTree, ['a', 'b']), { temp: 15, hum: 25, press: 100 });
});

test('CLI merge: value conflict exits 1', () => {
  const dir = tmpdir();
  const repoFile = path.join(dir, 'r.json');
  const outFile = path.join(dir, 'n.json');
  fs.writeFileSync(repoFile, JSON.stringify(makeBranchRepo(
    { set: { '/a': { temp: 1 } } },
    { set: { '/a': { temp: 2 } } },
  )));

  const result = run(['merge', '--repo', repoFile, '--base', 'm0', '--left', 'l1', '--right', 'r1', '--out', outFile]);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(outFile), false);
});

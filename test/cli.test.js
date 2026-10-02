import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from '../testutil/util.mjs';

const CLI = new URL('../cli.js', import.meta.url).pathname;

// NOTE: this sandboxed environment blocks piping child-process stdio back to
// the parent, so the CLI's stdout/stderr are captured via temp files instead.
let captureCounter = 0;
function run(args, cwd) {
  const outFile = path.join(cwd, `.cap-${process.pid}-${captureCounter++}.out`);
  const errFile = outFile + '.err';
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let status = null;
  let error = null;
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', outFd, errFd] });
    status = r.status;
    error = r.error;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  if (error) throw error;
  return { status, stdout, stderr };
}

function writeBatch(dir, name, batch) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(batch));
  return file;
}

test('CLI end-to-end: commit / forkinfo / merge / view / lincheck', () => {
  const dir = tmpdir();
  const repoDir = path.join(dir, 'repo');

  // commit base on main
  let r = run(['commit', writeBatch(dir, 'b1.json', {
    processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 1 }],
  }), '--repo', repoDir], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^branch main/m);
  assert.match(r.stdout, /^batch [0-9a-f]{64}/m);
  assert.match(r.stdout, /^version [0-9a-f]{64}/m);

  // unknown dependency -> E_ORPHAN
  r = run(['commit', writeBatch(dir, 'orphan.json', {
    processId: 'p1', clock: 2, deps: ['missing'], ops: [],
  }), '--repo', repoDir], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_ORPHAN:/m);

  // declared parents mismatch -> E_BAD_PARENT
  r = run(['commit', writeBatch(dir, 'badparent.json', {
    processId: 'p1', clock: 2, deps: [], parents: [], ops: [],
  }), '--repo', repoDir], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_BAD_PARENT:/m);

  // concurrent corrections on two branches
  r = run(['commit', writeBatch(dir, 'b2.json', {
    processId: 'p2', clock: 1, deps: [], from: 'main',
    ops: [{ op: 'assert', key: 'k', value: 20 }],
  }), '--repo', repoDir, '--branch', 'side'], dir);
  assert.equal(r.status, 0, r.stderr);
  r = run(['commit', writeBatch(dir, 'b3.json', {
    processId: 'p3', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 10 }],
  }), '--repo', repoDir, '--branch', 'main'], dir);
  assert.equal(r.status, 0, r.stderr);

  // forkinfo shows both branches and the conflict
  r = run(['forkinfo', '--repo', repoDir], dir);
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(r.stdout);
  assert.deepEqual(info.branches.map((b) => b.name), ['main', 'side']);
  assert.equal(info.pairs[0].conflicts[0].key, 'k');

  // merge -> E_CONFLICT, exit 1
  r = run(['merge', 'main', 'side', '--repo', repoDir], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_CONFLICT:/m);
  assert.match(r.stderr, /conflict k:/m);

  // views still show each branch's own value
  r = run(['view', 'rows', '--repo', repoDir, '--branch', 'main'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^k = 10$/m);
  r = run(['view', 'rows', '--repo', repoDir, '--branch', 'side'], dir);
  assert.match(r.stdout, /^k = 20$/m);

  // lincheck: linearizable log
  const goodLog = path.join(dir, 'good.json');
  fs.writeFileSync(goodLog, JSON.stringify({ events: [
    { type: 'commit', id: 'c1', processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 1 }] },
    { type: 'read', id: 'r1', processId: 'p2', clock: 1, deps: ['c1'], view: { k: 1 } },
  ] }));
  r = run(['lincheck', goodLog], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^LINEARIZABLE/m);

  // lincheck: impossible read -> E_NONLINEAR
  const badLog = path.join(dir, 'bad.json');
  fs.writeFileSync(badLog, JSON.stringify({ events: [
    { type: 'commit', id: 'c1', processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'k', value: 1 }] },
    { type: 'read', id: 'r1', processId: 'p2', clock: 1, deps: ['c1'], view: { k: 999 } },
  ] }));
  r = run(['lincheck', badLog], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_NONLINEAR:/m);
});

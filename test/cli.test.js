// End-to-end CLI test: two replicas exchange segments via the filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

// NOTE: this sandboxed environment drops piped stdout of grandchild
// processes, so the helper captures output via temp files instead of pipes.
function run(args) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-merge-cli-io-'));
  const outPath = path.join(out, 'stdout');
  const errPath = path.join(out, 'stderr');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const r = spawnSync('node', [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

test('CLI: commit/read/export/import/check/replay across two replicas', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-merge-cli-'));
  const dirA = path.join(base, 'A');
  const dirB = path.join(base, 'B');
  const segA = path.join(base, 'segA.jsonl');
  const segB = path.join(base, 'segB.jsonl');

  // replica A commits
  let r = run(['--dir', dirA, 'commit', '--write', 'x=1']);
  assert.equal(r.status, 0, r.stderr);
  const txn = JSON.parse(r.stdout);
  assert.equal(txn.id, 'A:1');
  assert.deepEqual(txn.clock, { A: 1 });

  // local read back
  r = run(['--dir', dirA, 'read', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '"1"');
  r = run(['--dir', dirA, 'read', 'nope']);
  assert.equal(r.stdout.trim(), 'null');

  // replica B commits on a disjoint key
  r = run(['--dir', dirB, 'commit', '--write', 'y=2']);
  assert.equal(r.status, 0, r.stderr);

  // export both, import crosswise
  r = run(['--dir', dirA, 'export', '--out', segA]);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dirB, 'export', '--out', segB]);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dirA, 'import', segB]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { imported: 1, duplicates: 0, corrupt: 0, status: 'OK' });
  r = run(['--dir', dirB, 'import', segA]);
  assert.equal(r.status, 0, r.stderr);
  // idempotent re-import
  r = run(['--dir', dirB, 'import', segA]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { imported: 0, duplicates: 1, corrupt: 0, status: 'OK' });

  // merged state visible on both sides
  for (const d of [dirA, dirB]) {
    r = run(['--dir', d, 'read', 'x']);
    assert.equal(r.stdout.trim(), '"1"');
    r = run(['--dir', d, 'read', 'y']);
    assert.equal(r.stdout.trim(), '"2"');
  }

  // check passes, replay is consistent
  r = run(['--dir', dirA, 'check']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /SERIALIZABLE/);
  r = run(['--dir', dirA, 'replay']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /CONSISTENT/);
  assert.match(r.stdout, /"x":"1"/);
  assert.match(r.stdout, /"y":"2"/);
});

test('CLI: conflicting merge reports NON_SERIALIZABLE with a cycle', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-merge-cli-conflict-'));
  const dirA = path.join(base, 'A');
  const dirB = path.join(base, 'B');
  const segA = path.join(base, 'segA.jsonl');
  const segB = path.join(base, 'segB.jsonl');

  // shared base, then concurrent read-modify-write of the same key
  assert.equal(run(['--dir', dirA, 'commit', '--write', 'x=0']).status, 0);
  assert.equal(run(['--dir', dirA, 'export', '--out', segA]).status, 0);
  assert.equal(run(['--dir', dirB, 'import', segA]).status, 0);
  assert.equal(run(['--dir', dirA, 'commit', '--read', 'x', '--write', 'x=A']).status, 0);
  assert.equal(run(['--dir', dirB, 'commit', '--read', 'x', '--write', 'x=B']).status, 0);
  assert.equal(run(['--dir', dirA, 'export', '--out', segA]).status, 0);
  assert.equal(run(['--dir', dirB, 'export', '--out', segB]).status, 0);
  assert.equal(run(['--dir', dirA, 'import', segB]).status, 0);

  const r = run(['--dir', dirA, 'check']);
  assert.equal(r.status, 3, r.stderr + r.stdout);
  assert.match(r.stdout, /NON_SERIALIZABLE/);
  assert.match(r.stdout, /conflict cycle: .*A:2.*B:1|conflict cycle: .*B:1.*A:2/);
});

test('CLI: importing a corrupt segment exits 4 and skips bad entries', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-merge-cli-corrupt-'));
  const dirA = path.join(base, 'A');
  const dirB = path.join(base, 'B');
  const seg = path.join(base, 'seg.jsonl');

  assert.equal(run(['--dir', dirA, 'commit', '--write', 'k=good']).status, 0);
  assert.equal(run(['--dir', dirA, 'export', '--out', seg]).status, 0);
  fs.appendFileSync(seg, 'garbage-line\n');

  const r = run(['--dir', dirB, 'import', seg]);
  assert.equal(r.status, 4, r.stderr + r.stdout);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, 'CORRUPT');
  assert.equal(report.corrupt, 1);
  assert.equal(report.imported, 1);
  assert.equal(run(['--dir', dirB, 'read', 'k']).stdout.trim(), '"good"');
});

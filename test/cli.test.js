import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';

const BIN = fileURLToPath(new URL('../bin/mvcc.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mvcc-cli-'));
}

// Runs the CLI in-process and captures output + exit code.
function cli(args) {
  let stdout = '';
  let stderr = '';
  const status = runCli(args, {
    stdout: (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

test('cli: commit / snapshot / read --tag / gc workflow', () => {
  const db = tmpdir();

  let res = cli(['commit', '--db', db, 'alpha=1', 'beta=2']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /committed seq=1/);

  res = cli(['commit', '--db', db, '--set', 'alpha=10', '--set', 'gamma=3']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /committed seq=2/);

  res = cli(['snapshot', '--db', db, 'release-1']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /snapshot release-1 seq=2/);

  // Data keeps changing after the tag.
  res = cli(['commit', '--db', db, '--set', 'alpha=99', '--delete', 'beta']);
  assert.equal(res.status, 0, res.stderr);

  // Current view reflects the latest commit.
  res = cli(['read', '--db', db, 'alpha']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '99\n');
  res = cli(['read', '--db', db, 'beta']);
  assert.equal(res.status, 1); // deleted key

  // Tagged view is frozen at seq 2.
  res = cli(['read', '--db', db, '--tag', 'release-1', 'alpha']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '10\n');
  res = cli(['read', '--db', db, '--tag', 'release-1']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'alpha=10\nbeta=2\ngamma=3\n');

  // gc must refuse to reclaim the tagged snapshot's horizon...
  res = cli(['gc', '--db', db]);
  assert.equal(res.status, 4, res.stderr);
  assert.match(res.stderr, /GC_REFUSED/);
  // ...but allows a safe horizon, after which the tag still reads fine.
  res = cli(['gc', '--db', db, '--before', '2']);
  assert.equal(res.status, 0, res.stderr);
  res = cli(['read', '--db', db, '--tag', 'release-1']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'alpha=10\nbeta=2\ngamma=3\n');
});

test('cli: read with unknown tag exits 3 with NO_TAG', () => {
  const db = tmpdir();
  const res = cli(['read', '--db', db, '--tag', 'missing', 'k']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /NO_TAG/);
});

test('cli: usage errors exit 1', () => {
  assert.equal(cli(['commit']).status, 1);
  assert.match(cli(['bogus-command']).stderr, /ERROR/);
  assert.equal(cli(['gc', '--db', tmpdir(), '--before', 'abc']).status, 1);
});

test('cli: data persists across separate runCli invocations (WAL on disk)', () => {
  const db = tmpdir();
  assert.equal(cli(['commit', '--db', db, 'persist=yes']).status, 0);
  assert.equal(cli(['snapshot', '--db', db, 'p1']).status, 0);
  const res = cli(['read', '--db', db, '--tag', 'p1', 'persist']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'yes\n');
});

// Genuine subprocess smoke test. Some sandboxed environments block child
// process pipes; detect that with a canary and skip instead of failing.
function spawnWorks() {
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    encoding: 'utf8',
  });
  return !probe.error && probe.stdout === 'ok';
}

test('cli: bin/mvcc.js runs as a real subprocess', (t) => {
  if (!spawnWorks()) {
    t.skip('child process pipes are blocked in this environment');
    return;
  }
  const db = tmpdir();
  const commit = spawnSync(process.execPath, [BIN, 'commit', '--db', db, 'k=v'], {
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stdout, /committed seq=1/);
  const read = spawnSync(process.execPath, [BIN, 'read', '--db', db, 'k'], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, 'v\n');
});

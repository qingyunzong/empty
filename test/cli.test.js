'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');

let capture = 0;

function run(args) {
  capture += 1;
  const outFile = path.join(os.tmpdir(), `cli-${process.pid}-${capture}.out`);
  const errFile = path.join(os.tmpdir(), `cli-${process.pid}-${capture}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const result = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile);
  fs.rmSync(errFile);
  return { status: result.status, stdout, stderr };
}

function ok(args) {
  const r = run(args);
  assert.equal(r.status, 0, 'expected success: ' + args.join(' ') + '\n' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

function fail(args) {
  const r = run(args);
  assert.equal(r.status, 1, 'expected failure: ' + args.join(' ') + '\n' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

test('cli: freeze/release/member lifecycle with JSON output and error codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-replica-'));
  const s1 = path.join(dir, 's1.json');
  const s2 = path.join(dir, 's2.json');

  assert.deepEqual(ok(['account', 'acct', '--limit', '500', '--state', s1]), {
    account: 'acct',
    limit: 500,
    frozen: 0,
    available: 500,
  });

  const added = ok(['add-member', '--member', 'm1', '--request-id', 'cfg-1', '--state', s1]);
  assert.equal(added.type, 'add-member');
  assert.equal(added.epoch, 1);
  assert.equal(typeof added.hash, 'string');

  const f1 = ok(['freeze', '--account', 'acct', '--amount', '200', '--member', 'm1', '--request-id', 'f1', '--state', s1]);
  assert.equal(f1.type, 'freeze');
  assert.equal(f1.prev, null);

  assert.deepEqual(ok(['account', 'acct', '--state', s1]), {
    account: 'acct',
    limit: 500,
    frozen: 200,
    available: 300,
  });

  assert.deepEqual(
    fail(['freeze', '--account', 'acct', '--amount', '400', '--member', 'm1', '--request-id', 'f2', '--state', s1]),
    { error: 'limit-exceeded' },
  );
  assert.deepEqual(
    fail(['freeze', '--account', 'acct', '--amount', '10', '--member', 'm9', '--request-id', 'fx', '--state', s1]),
    { error: 'unknown-member' },
  );

  fs.copyFileSync(s1, s2);
  ok(['freeze', '--account', 'acct', '--amount', '100', '--member', 'm1', '--request-id', 'f3', '--state', s2]);

  assert.deepEqual(ok(['diff', s2, '--state', s1]), {
    missingFreezes: ['f3'],
    missingReleases: [],
    missingMembers: [],
  });

  const merged = ok(['merge', s2, '--state', s1]);
  assert.deepEqual(merged.rejected, []);
  assert.deepEqual(merged.merged, ['f3']);
  assert.equal(ok(['account', 'acct', '--state', s1]).frozen, 300);

  const r1 = ok(['release', '--member', 'm1', '--target', 'f1', '--request-id', 'r1', '--state', s1]);
  assert.equal(r1.type, 'release');
  assert.equal(ok(['account', 'acct', '--state', s1]).frozen, 100);

  assert.deepEqual(
    fail(['remove-member', '--member', 'm1', '--request-id', 'cfg-bad', '--frontier', f1.hash, '--state', s1]),
    { error: 'remove-incomplete' },
  );

  const removed = ok(['remove-member', '--member', 'm1', '--request-id', 'cfg-rm', '--state', s1]);
  assert.equal(removed.frontier, r1.hash);

  ok(['freeze', '--account', 'acct', '--amount', '10', '--member', 'm1', '--request-id', 'f4', '--state', s2]);
  const staleMerge = ok(['merge', s2, '--state', s1]);
  assert.deepEqual(staleMerge.rejected, [{ id: 'f4', error: 'stale-member' }]);
  assert.equal(ok(['account', 'acct', '--state', s1]).frozen, 100);

  assert.deepEqual(
    fail(['freeze', '--account', 'acct', '--amount', '10', '--member', 'm1', '--request-id', 'f5', '--state', s1]),
    { error: 'stale-member' },
  );
});

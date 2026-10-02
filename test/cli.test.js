import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../bin/cli.js';
import { tmpStore, readLines, writeLines, cleanup } from '../support/helpers.js';

// In-process CLI runner: the sandbox forbids spawning child processes, and
// running through the exported entry point exercises identical code paths.
function cli(args) {
  let stdout = '';
  let stderr = '';
  const status = run(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { status, stdout, stderr };
}

test('CLI end-to-end: event/revoke/challenge/verify/snapshot', () => {
  const dir = tmpStore();
  try {
    let r = cli(['event', '--store', dir, '--type', 'receive', '--actor', 'alice', '--sample', 'S1', '--consent', 'C1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).appended.seq, 0);

    r = cli(['event', '--store', dir, '--type', 'transfer', '--actor', 'bob', '--sample', 'S1', '--consent', 'C1', '--payload', '{"to":"lab-7"}']);
    assert.equal(r.status, 0, r.stderr);

    r = cli(['snapshot', '--store', dir]);
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(r.stdout);
    assert.equal(manifest.leafCount, 2);
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));

    r = cli(['challenge', '--store', dir, '--index', '1']);
    assert.equal(r.status, 0, r.stderr);
    const proof = JSON.parse(r.stdout);
    assert.equal(proof.index, 1);
    const proofFile = path.join(dir, 'proof.json');
    fs.writeFileSync(proofFile, JSON.stringify(proof));

    r = cli(['verify', '--store', dir, '--proof', proofFile]);
    assert.equal(r.status, 0, r.stderr);
    const v = JSON.parse(r.stdout);
    assert.equal(v.ok, true);
    assert.equal(v.proof.valid, true);

    r = cli(['revoke', '--store', dir, '--consent', 'C1', '--actor', 'bob', '--reason', 'withdrawn']);
    assert.equal(r.status, 0, r.stderr);

    r = cli(['event', '--store', dir, '--type', 'analyze', '--actor', 'lab', '--sample', 'S1', '--consent', 'C1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR REVOKED_CONSENT/);

    r = cli(['verify', '--store', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).restricted, [0, 1]);

    r = cli(['list', '--store', dir]);
    const events = JSON.parse(r.stdout);
    assert.equal(events[0].restricted, true);
    assert.equal(events[2].restricted, false);
  } finally {
    cleanup(dir);
  }
});

test('CLI reports BROKEN_CHAIN with the tampered seq', () => {
  const dir = tmpStore();
  try {
    cli(['event', '--store', dir, '--type', 'receive', '--actor', 'a', '--sample', 'S1', '--consent', 'C1']);
    cli(['event', '--store', dir, '--type', 'transfer', '--actor', 'b', '--sample', 'S1', '--consent', 'C1']);
    const lines = readLines(dir);
    const ev = JSON.parse(lines[0]);
    ev.actor = 'mallory';
    lines[0] = JSON.stringify(ev);
    writeLines(dir, lines);
    const r = cli(['verify', '--store', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR BROKEN_CHAIN/);
    assert.match(r.stderr, /"seq":0/);
  } finally {
    cleanup(dir);
  }
});

test('CLI challenge on empty store and bad index gives NO_PROOF', () => {
  const dir = tmpStore();
  try {
    let r = cli(['challenge', '--store', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR NO_PROOF/);
    cli(['event', '--store', dir, '--type', 'receive', '--actor', 'a', '--sample', 'S1', '--consent', 'C1']);
    r = cli(['challenge', '--store', dir, '--index', '5']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR NO_PROOF/);
  } finally {
    cleanup(dir);
  }
});

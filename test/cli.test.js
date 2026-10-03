'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnNode } = require('../test-support/helpers');

const CLI = path.join(__dirname, '..', 'cli.js');

function run(args, opts = {}) {
  return spawnNode([CLI, ...args], opts);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-cli-'));
}

test('CLI end-to-end: init/put/get/del/scan/history with --at snapshots', () => {
  const dir = tmpdir();

  let r = run(['--dir', dir, 'init']);
  assert.equal(r.status, 0, r.stderr);

  r = run(['--dir', dir, 'put', 'vega', 'mag=0.03']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /version=1/);

  r = run(['--dir', dir, 'put', 'vega', 'mag=0.04']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /version=2/);

  r = run(['--dir', dir, 'put', 'sirius', 'mag=-1.46']);
  assert.equal(r.status, 0, r.stderr);

  // current read
  r = run(['--dir', dir, 'get', 'vega']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'mag=0.04');

  // historical snapshot read
  r = run(['--dir', dir, 'get', 'vega', '--at', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'mag=0.03');

  // scan
  r = run(['--dir', dir, 'scan']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['sirius\tmag=-1.46', 'vega\tmag=0.04']);

  // scan at older version only sees keys committed by then
  r = run(['--dir', dir, 'scan', '--at', '2']);
  assert.deepEqual(r.stdout.trim().split('\n'), ['vega\tmag=0.04']);

  // history
  r = run(['--dir', dir, 'history', 'vega']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['1\tmag=0.03', '2\tmag=0.04']);

  // delete, then NOT_FOUND on get, tombstone in history
  r = run(['--dir', dir, 'del', 'vega']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dir, 'get', 'vega']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT_FOUND/);
  r = run(['--dir', dir, 'history', 'vega']);
  assert.match(r.stdout, /4\tDELETED/);
});

test('CLI error conventions: NOT_FOUND and INVALID exit non-zero', () => {
  const dir = tmpdir();
  run(['--dir', dir, 'init']);

  let r = run(['--dir', dir, 'get', 'missing']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ERROR NOT_FOUND/);

  r = run(['--dir', dir, 'del', 'missing']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ERROR NOT_FOUND/);

  r = run(['--dir', dir, 'get']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ERROR INVALID/);

  r = run(['--dir', dir, 'get', 'k', '--at', 'abc']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ERROR INVALID/);

  r = run(['--dir', dir, 'bogus-command']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ERROR INVALID/);

  r = run(['--dir', path.join(dir, 'never-initialized'), 'get', 'k']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ERROR INVALID/);
});

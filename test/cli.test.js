'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

// NB: in this sandbox a node child's pipe-stdout can be swallowed, so we
// capture output via temp files instead of pipes.
let captureCounter = 0;
function run(...args) {
  const base = path.join(os.tmpdir(), `obs-cli-cap-${process.pid}-${captureCounter++}`);
  const outFd = fs.openSync(`${base}.out`, 'w');
  const errFd = fs.openSync(`${base}.err`, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(`${base}.out`, 'utf8'),
    stderr: fs.readFileSync(`${base}.err`, 'utf8'),
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-store-cli-'));
}

test('init/put/get/del/scan/history happy path', () => {
  const dir = path.join(tmpdir(), 'db');

  let r = run('init', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'store.wal')));

  r = run('put', dir, 'vega', 'mag=0.03');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^v1\n$/);

  r = run('put', dir, 'vega', 'mag=0.04'); // correction
  assert.match(r.stdout, /^v2\n$/);
  run('put', dir, 'sirius', 'mag=-1.46');

  r = run('get', dir, 'vega');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'mag=0.04\n');

  // --at reads a historical snapshot.
  r = run('get', dir, 'vega', '--at', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'mag=0.03\n');

  r = run('scan', dir);
  assert.equal(r.stdout, 'sirius\tmag=-1.46\nvega\tmag=0.04\n');

  r = run('scan', dir, '--prefix', 've');
  assert.equal(r.stdout, 'vega\tmag=0.04\n');

  r = run('scan', dir, '--at', '1');
  assert.equal(r.stdout, 'vega\tmag=0.03\n');

  r = run('del', dir, 'vega');
  assert.equal(r.status, 0, r.stderr);
  r = run('get', dir, 'vega');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^NOT_FOUND/);

  r = run('history', dir, 'vega');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'v1\tmag=0.03\nv2\tmag=0.04\nv4\t<deleted>\n');
});

test('NOT_FOUND for missing key, non-zero exit', () => {
  const dir = tmpdir();
  run('init', dir);
  const r = run('get', dir, 'nope');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^NOT_FOUND/);
  const h = run('history', dir, 'nope');
  assert.notEqual(h.status, 0);
  assert.match(h.stderr, /^NOT_FOUND/);
});

test('INVALID for bad arguments, non-zero exit', () => {
  const dir = tmpdir();
  assert.notEqual(run('init').status, 0);
  assert.notEqual(run('put', dir, 'onlykey').status, 0);
  assert.notEqual(run('bogus-command', dir).status, 0);
  run('init', dir);
  const r = run('get', dir, 'k', '--at', 'abc');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^INVALID/);
  const f = run('get', dir, 'k', '--bogus');
  assert.match(f.stderr, /^INVALID/);
});

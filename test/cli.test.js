'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'snapcli-')); }

// Invoke the CLI entry point in-process (sandbox forbids child processes),
// capturing exactly what would go to stdout/stderr.
function run(args, env = {}) {
  let stdout = '', stderr = '';
  const code = main(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } }, env);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

test('CLI: write/resume/verify/diff/materialize round trip', () => {
  const repo = tmpdir();
  const src = tmpdir();
  fs.writeFileSync(path.join(src, 'a.txt'), 'alpha');
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'beta');

  let r = run(['write', repo, src]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).version, 1);

  r = run(['resume', repo]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { status: 'clean', version: 1 });

  fs.writeFileSync(path.join(src, 'a.txt'), 'ALPHA');
  fs.rmSync(path.join(src, 'sub', 'b.txt'));
  fs.writeFileSync(path.join(src, 'c.txt'), 'gamma');
  r = run(['write', repo, src]);
  assert.deepEqual(JSON.parse(r.stdout).version, 2);

  r = run(['diff', repo, '1', '2']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), [
    { op: 'modified', path: 'a.txt' },
    { op: 'added', path: 'c.txt' },
    { op: 'removed', path: 'sub/b.txt' },
  ]);

  const dest = tmpdir();
  r = run(['materialize', repo, '2', dest]);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'ALPHA');

  r = run(['verify', repo]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).ok, true);
});

test('CLI: injected crash -> ERR_CRASH JSON on stderr, resume recovers', () => {
  const repo = tmpdir();
  const src = tmpdir();
  fs.writeFileSync(path.join(src, 'x.txt'), 'one');
  run(['write', repo, src]);

  fs.writeFileSync(path.join(src, 'x.txt'), 'two');
  let r = run(['write', repo, src], { SNAP_FAULT: 'journal-uncommitted' });
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stderr).error, 'ERR_CRASH');

  r = run(['verify', repo]);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stderr).error, 'ERR_DIRTY');

  r = run(['resume', repo]);
  assert.equal(r.code, 0);
  const rec = JSON.parse(r.stdout);
  assert.equal(rec.status, 'recovered');
  assert.equal(rec.version, 1);

  r = run(['verify', repo]);
  assert.equal(r.code, 0);
});

test('CLI: ERR_CHUNK and ERR_VERSION go to stderr as JSON', () => {
  const repo = tmpdir();
  const src = tmpdir();
  fs.writeFileSync(path.join(src, 'x.txt'), 'payload');
  run(['write', repo, src]);

  let r = run(['materialize', repo, '42', tmpdir()]);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stderr).error, 'ERR_VERSION');

  const chunk = fs.readdirSync(path.join(repo, 'chunks'))[0];
  fs.writeFileSync(path.join(repo, 'chunks', chunk), 'corrupted');
  r = run(['verify', repo]);
  assert.equal(r.code, 1);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'ERR_CHUNK');
  assert.ok(Array.isArray(err.details.problems));
});

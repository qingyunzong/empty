'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runCli } = require('../src/cli.js');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factoring-cli-')), 'store.json');
}

test('CLI end-to-end: init, add, totals, clusters, revoke, restart', () => {
  const file = tmpFile();
  let r = runCli(['init', '--file', file, '--credit-line', '50000', '--slop', '1']);
  assert.equal(r.code, 0, r.stderr);

  r = runCli(['add', '--file', file, '--id', 'a', '--creditor', 'acme', '--face-value', '10000', '--advance-rate', '0.8', '--memo', 'steel delivery']);
  assert.equal(r.code, 0, r.stderr);
  r = runCli(['add', '--file', file, '--id', 'b', '--creditor', 'acme', '--face-value', '5000', '--advance-rate', '0.5', '--memo', 'steel delivery note']);
  assert.equal(r.code, 0, r.stderr);

  r = runCli(['totals', '--file', file]);
  assert.deepEqual(JSON.parse(r.stdout), { creditLine: 50000, frozen: 10500, available: 39500 });

  r = runCli(['clusters', '--file', file]);
  assert.equal(JSON.parse(r.stdout)[0].members.length, 2);

  // Revoke both members; the cluster slot must vanish from disk.
  runCli(['revoke', '--file', file, '--id', 'a']);
  r = runCli(['revoke', '--file', file, '--id', 'b']);
  const cert = JSON.parse(r.stdout);
  assert.equal(cert.clusterRemoved, true);

  // "Restart": a fresh process view over the same file shows no empty cluster.
  r = runCli(['clusters', '--file', file]);
  assert.deepEqual(JSON.parse(r.stdout), []);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.clusterSlots.length, 0);
});

test('CLI reports errors with exit code 1 and a stable error code', () => {
  const file = tmpFile();
  runCli(['init', '--file', file, '--credit-line', '100']);

  let r = runCli(['add', '--file', file, '--id', 'x', '--creditor', 'c', '--face-value', '100', '--advance-rate', '1.5']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INVALID_ADVANCE_RATE/);

  r = runCli(['add', '--file', file, '--id', 'x', '--creditor', 'c', '--face-value', '1000', '--advance-rate', '0.5']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CREDIT_LINE_EXCEEDED/);

  runCli(['add', '--file', file, '--id', 'x', '--creditor', 'c', '--face-value', '100', '--advance-rate', '0.5']);
  runCli(['revoke', '--file', file, '--id', 'x']);
  r = runCli(['revoke', '--file', file, '--id', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INVOICE_ALREADY_REVOKED/);

  r = runCli(['nonsense', '--file', file]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BAD_ARGS/);
});

test('CLI executable works as a real subprocess (skipped if spawning is blocked)', (t) => {
  const probe = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'EPERM') {
    t.skip('sandbox blocks child processes');
    return;
  }
  const file = tmpFile();
  const init = spawnSync(process.execPath, [CLI, 'init', '--file', file, '--credit-line', '1000'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const totals = spawnSync(process.execPath, [CLI, 'totals', '--file', file], { encoding: 'utf8' });
  assert.equal(totals.status, 0, totals.stderr);
  assert.deepEqual(JSON.parse(totals.stdout), { creditLine: 1000, frozen: 0, available: 1000 });
  const bad = spawnSync(process.execPath, [CLI, 'revoke', '--file', file, '--id', 'ghost'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /INVOICE_NOT_FOUND/);
});

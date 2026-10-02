import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'param-sync-cli-'));
}

// In-process CLI invocation with captured streams (offline, no subprocess).
function run(argv, env = {}) {
  let out = '';
  let err = '';
  const status = runCli(argv, {
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    env: { ...env },
  });
  return { status, stdout: out, stderr: err };
}

function writeDefs(dir) {
  const defs = [
    { key: 'temp', type: 'number', min: 0, max: 100, safety: true },
    { key: 'heater', type: 'boolean', interlock: 'heater == false || temp < 80' },
    { key: 'mode', type: 'string' },
  ];
  const p = path.join(dir, 'defs.json');
  fs.writeFileSync(p, JSON.stringify(defs));
  return p;
}

test('pack + apply happy path', () => {
  const dir = tmpdir();
  const defs = writeDefs(dir);
  const values = path.join(dir, 'values.json');
  fs.writeFileSync(values, JSON.stringify({ temp: 50, heater: true, mode: 'auto' }));
  const pack = path.join(dir, 'pack.json');
  let r = run(['pack', '--def', defs, '--values', values, '--out', pack]);
  assert.equal(r.status, 0, r.stderr);
  r = run(['apply', '--db', path.join(dir, 'db'), '--pack', pack]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).applied, ['temp', 'heater', 'mode']);
});

test('out-of-range value exits 2 with VALIDATION JSON on stderr', () => {
  const dir = tmpdir();
  const defs = writeDefs(dir);
  const values = path.join(dir, 'values.json');
  fs.writeFileSync(values, JSON.stringify({ temp: 500 }));
  const r = run(['pack', '--def', defs, '--values', values]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'VALIDATION');
});

test('interlock violation exits 2', () => {
  const dir = tmpdir();
  const defs = writeDefs(dir);
  const values = path.join(dir, 'values.json');
  fs.writeFileSync(values, JSON.stringify({ temp: 90, heater: true }));
  const pack = path.join(dir, 'pack.json');
  const r = run(['pack', '--def', defs, '--values', values, '--out', pack]);
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stderr).error.message, /interlock/);
});

test('safety-critical sync conflict exits 11 with SYNC_PENDING', () => {
  const dir = tmpdir();
  const defs = writeDefs(dir);
  const values = path.join(dir, 'values.json');
  fs.writeFileSync(values, JSON.stringify({ temp: 50 }));
  const pack = path.join(dir, 'pack.json');
  run(['pack', '--def', defs, '--values', values, '--out', pack]);
  run(['apply', '--db', path.join(dir, 'db'), '--pack', pack]);
  const fb = run(['feedback', '--db', path.join(dir, 'fb'), '--def', defs, '--key', 'temp', '--value', '55']);
  assert.equal(fb.status, 0, fb.stderr);
  const r = run(['sync', '--dispatch', path.join(dir, 'db'), '--feedback', path.join(dir, 'fb')]);
  assert.equal(r.status, 11);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'SYNC_PENDING');
  assert.equal(err.error.details.pending[0].key, 'temp');
});

test('rollback wrong phase order exits 3 with ROLLBACK', () => {
  const dir = tmpdir();
  const defs = writeDefs(dir);
  const values = path.join(dir, 'values.json');
  fs.writeFileSync(values, JSON.stringify({ temp: 50 }));
  const pack = path.join(dir, 'pack.json');
  run(['pack', '--def', defs, '--values', values, '--out', pack]);
  const db = path.join(dir, 'db');
  run(['apply', '--db', db, '--pack', pack]);
  const r = run(['rollback', '--db', db, '--phase', 'cert-clear']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stderr).error.code, 'ROLLBACK');
  // correct order works
  assert.equal(run(['rollback', '--db', db, '--phase', 'unlock']).status, 0);
  assert.equal(run(['rollback', '--db', db, '--phase', 'revert']).status, 0);
  assert.equal(run(['rollback', '--db', db, '--phase', 'cert-clear']).status, 0);
});

test('cert lifecycle via CLI', () => {
  const dir = tmpdir();
  const db = path.join(dir, 'db');
  fs.mkdirSync(db);
  let r = run(['cert', '--db', db, 'issue', '--id', 'c1', '--subject', 'op']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['cert', '--db', db, 'list']);
  assert.equal(JSON.parse(r.stdout).certs.length, 1);
  r = run(['cert', '--db', db, 'clear']);
  assert.equal(JSON.parse(r.stdout).cleared, 1);
});

test('fault injection via env: crash then recover, no half-apply', () => {
  const dir = tmpdir();
  const defs = writeDefs(dir);
  const values = path.join(dir, 'values.json');
  fs.writeFileSync(values, JSON.stringify({ temp: 95 }));
  const safe = path.join(dir, 'safe.json');
  fs.writeFileSync(safe, JSON.stringify({ temp: 0 }));
  const pack = path.join(dir, 'pack.json');
  run(['pack', '--def', defs, '--values', values, '--safe-set', safe, '--out', pack]);
  const db = path.join(dir, 'db');
  const crashed = run(['apply', '--db', db, '--pack', pack], { PARAM_SYNC_FAULT: 'before-active-rename' });
  assert.notEqual(crashed.status, 0);
  assert.equal(JSON.parse(crashed.stderr).error.code, 'FAULT');
  // recovery happens on next command touching the db
  const fb = path.join(dir, 'fb');
  run(['feedback', '--db', fb, '--def', defs, '--key', 'mode', '--value', 'x']);
  const r = run(['sync', '--dispatch', db, '--feedback', fb]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.merged.params.temp.value, 0, 'dangerous value covered by safe set after recovery');
});

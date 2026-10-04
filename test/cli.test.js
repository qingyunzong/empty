import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from './helpers.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;

const DEFS = [
  { key: 'temp', type: 'number', min: 0, max: 100, safetyCritical: true },
  { key: 'pressure', type: 'number', min: 0, max: 10, safetyCritical: true, interlock: 'temp < 50 || pressure > 2' },
  { key: 'boost', type: 'boolean' },
];

function setup() {
  const dir = tmpdir();
  const defFile = path.join(dir, 'defs.json');
  fs.writeFileSync(defFile, JSON.stringify(DEFS));
  return { dir, defFile };
}

// The sandbox intermittently reports EPERM on spawn while the child still
// runs; accept any result that produced output, otherwise retry.
function run(args, opts = {}) {
  let r;
  for (let attempt = 0; attempt < 10; attempt++) {
    r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
    if (r.stdout !== '' || r.stderr !== '') return r;
    if (!r.error && r.status !== null) return r;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return r;
}

test('pack rejects out-of-range change: stderr JSON, exit 2', () => {
  const { dir, defFile } = setup();
  const r = run(['pack', '--def', defFile, '--set', 'temp=120', '--out', path.join(dir, 'p.json')]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'VALIDATION');
  assert.match(err.message, /out of range/);
});

test('pack rejects interlock violation: exit 2', () => {
  const { dir, defFile } = setup();
  const changes = path.join(dir, 'changes.json');
  fs.writeFileSync(changes, JSON.stringify([
    { op: 'set', key: 'pressure', value: 1 },
    { op: 'set', key: 'temp', value: 80 },
  ]));
  const r = run(['pack', '--def', defFile, '--changes', changes, '--out', path.join(dir, 'p.json')]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error, 'VALIDATION');
});

test('pack -> apply -> feedback -> sync happy path: exit 0', () => {
  const { dir, defFile } = setup();
  const packFile = path.join(dir, 'pack.json');
  const storeDir = path.join(dir, 'store');
  const fbFile = path.join(dir, 'fb.json');
  const mergedFile = path.join(dir, 'merged.json');

  let r = run(['pack', '--def', defFile, '--set', 'boost=true', '--set', 'temp=40', '--out', packFile]);
  assert.equal(r.status, 0, r.stderr);

  r = run(['apply', '--def', defFile, '--store', storeDir, '--pack', packFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).state.values.temp, 40);

  r = run(['feedback', '--def', defFile, '--store', storeDir, '--out', fbFile]);
  assert.equal(r.status, 0, r.stderr);

  r = run(['sync', '--def', defFile, '--a', packFile, '--b', fbFile, '--out', mergedFile]);
  assert.equal(r.status, 0, r.stderr);
  const merged = JSON.parse(fs.readFileSync(mergedFile, 'utf8'));
  assert.equal(merged.pending.length, 0);
});

test('sync with safety-critical conflict: stderr JSON, exit 11', () => {
  const { dir, defFile } = setup();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(a, JSON.stringify({ node: 'eng', vector: { eng: 1 }, entries: [{ op: 'set', key: 'temp', value: 60, node: 'eng', vector: { eng: 1 } }] }));
  fs.writeFileSync(b, JSON.stringify({ node: 'ctl', vector: { ctl: 1 }, entries: [{ op: 'set', key: 'temp', value: 30, node: 'ctl', vector: { ctl: 1 } }] }));
  const r = run(['sync', '--def', defFile, '--a', a, '--b', b, '--out', path.join(dir, 'm.json')]);
  assert.equal(r.status, 11);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'CONFLICT');
  assert.deepEqual(err.details.pending, ['temp']);
});

test('rollback wrong order: stderr JSON, exit 3; full order succeeds', () => {
  const { dir, defFile } = setup();
  const storeDir = path.join(dir, 'store');
  const packFile = path.join(dir, 'pack.json');
  assert.equal(run(['pack', '--def', defFile, '--set', 'temp=40', '--out', packFile]).status, 0);
  assert.equal(run(['apply', '--def', defFile, '--store', storeDir, '--pack', packFile]).status, 0);
  assert.equal(run(['cert', '--def', defFile, '--store', storeDir, '--issue', 'temp', '--value', 'CERT-1']).status, 0);

  let r = run(['rollback', '--def', defFile, '--store', storeDir, '--phase', 'certs']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stderr).error, 'ROLLBACK');

  r = run(['rollback', '--def', defFile, '--store', storeDir]);
  assert.equal(r.status, 0, r.stderr);

  r = run(['cert', '--def', defFile, '--store', storeDir, '--list']);
  assert.deepEqual(JSON.parse(r.stdout).certs, {});
});

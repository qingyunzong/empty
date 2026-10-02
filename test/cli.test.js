import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAP, grant, task } from '../fixtures/helpers.mjs';

const CLI = new URL('../bin/agv-scheduler.js', import.meta.url).pathname;

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'agv-'));
  writeFileSync(join(dir, 'map.json'), JSON.stringify(MAP));
  return dir;
}

function run(dir, args = []) {
  // Sandboxed environments may refuse stderr pipes for nested spawns, so the
  // child's stderr is redirected to a file and read back.
  const stderrPath = join(dir, 'stderr.txt');
  const fd = openSync(stderrPath, 'w');
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      '--map', join(dir, 'map.json'),
      '--tasks', join(dir, 'tasks.jsonl'),
      '--grants', join(dir, 'grants.jsonl'),
      '--plan', join(dir, 'plan.jsonl'),
      '--deny', join(dir, 'deny.jsonl'),
      ...args,
    ],
    { stdio: ['ignore', 'ignore', fd] },
  );
  closeSync(fd);
  return { status: result.status, stderr: readFileSync(stderrPath, 'utf8') };
}

function writeJsonl(dir, name, records) {
  writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readJsonl(path) {
  const text = readFileSync(path, 'utf8').trim();
  return text === '' ? [] : text.split('\n').map((l) => JSON.parse(l));
}

test('CLI: writes plan.jsonl and deny.jsonl, exit 0', () => {
  const dir = setupDir();
  writeJsonl(dir, 'grants.jsonl', [grant('G1', { zone: 'Z-COLD' })]);
  writeJsonl(dir, 'tasks.jsonl', [
    task('T1', { target: { zone: 'Z-COLD' }, parents: ['G1'] }),
    task('T2', {
      target: { zone: 'Z-RESTRICTED' },
      parents: ['G1'],
      clock: { node: 'agv-1', counter: 3 },
    }),
  ]);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const plan = readJsonl(join(dir, 'plan.jsonl'));
  const deny = readJsonl(join(dir, 'deny.jsonl'));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].task, 'T1');
  assert.deepEqual(plan[0].causalChain, ['G1', 'T1']);
  assert.equal(deny.length, 1);
  assert.equal(deny[0].task, 'T2');
});

test('CLI: exits 22 on missing parent event', () => {
  const dir = setupDir();
  writeJsonl(dir, 'grants.jsonl', []);
  writeJsonl(dir, 'tasks.jsonl', [task('T1', { parents: ['NOPE'] })]);
  const result = run(dir);
  assert.equal(result.status, 22);
  assert.match(result.stderr, /missing parent/);
});

test('CLI: exits 23 on out-of-bounds coordinate', () => {
  const dir = setupDir();
  writeJsonl(dir, 'grants.jsonl', []);
  writeJsonl(dir, 'tasks.jsonl', [task('T1', { target: { x: -1, y: 0 } })]);
  const result = run(dir);
  assert.equal(result.status, 23);
});

test('CLI: exits 24 on duplicate rescue authorizer', () => {
  const dir = setupDir();
  writeJsonl(dir, 'grants.jsonl', []);
  writeJsonl(dir, 'tasks.jsonl', [
    task('T1', { type: 'rescue', target: { shelf: 'S-R-1' }, authorizers: ['x', 'x'] }),
  ]);
  const result = run(dir);
  assert.equal(result.status, 24);
});

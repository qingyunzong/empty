import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Archive, ArchiveError } from '../src/archive.js';
import { Querier } from '../src/query.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function buildArchive(dir) {
  const archive = new Archive(dir);
  archive.append({ ts: 1, device: 'd1', tokens: 'alpha beta' });
  archive.append({ ts: 2, device: 'd1', tokens: 'beta gamma' });
  archive.freeze(); // seg-000001, window [1,2]
  archive.append({ ts: 3, device: 'd1', tokens: 'delta epsilon' });
  archive.append({ ts: 4, device: 'd1', tokens: 'epsilon zeta' });
  archive.freeze(); // seg-000002, window [3,4]
  archive.append({ ts: 5, device: 'd1', tokens: 'zeta omega' });
  archive.freeze(); // seg-000003, window [5,5]
  return archive;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acceptance 2: killing merge mid-flight must leave the old window usable.
test('merge killed before commit keeps old window usable', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-merge-'));
  buildArchive(dir);
  const before = new Querier(new Archive(dir)).phrase('gamma delta');
  assert.equal(before.length, 1); // spans seg1 -> seg2
  const beforeSegs = [...new Archive(dir).manifest.frozen];

  const child = spawn(process.execPath, [CLI, 'merge', '--archive', dir, '--from', '1', '--to', '4'], {
    env: { ...process.env, ARCHIVE_MERGE_DELAY_MS: '2000' },
    stdio: 'ignore',
  });
  await sleep(500); // staged, paused before the atomic manifest commit
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));

  const after = new Archive(dir);
  assert.deepEqual(after.manifest.frozen, beforeSegs, 'manifest must still list old segments');
  const querier = new Querier(after);
  assert.deepEqual(querier.phrase('gamma delta'), before, 'old window must answer queries');
  assert.equal(querier.phrase('zeta omega').length, 1);

  // next command triggers cleanup of the staged segment
  new Archive(dir).stats();
  const left = fs.readdirSync(path.join(dir, 'frozen')).filter((n) => !beforeSegs.includes(n));
  assert.deepEqual(left, [], 'staging leftovers must be cleaned up');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('successful merge atomically replaces window and preserves results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-merge-ok-'));
  buildArchive(dir);
  const before = new Querier(new Archive(dir)).near('alpha', 'zeta', 10);
  const archive = new Archive(dir);
  const res = archive.merge(1, 4);
  assert.deepEqual(res.merged, ['seg-000001', 'seg-000002']);
  assert.equal(archive.manifest.frozen.length, 2);
  const after = new Querier(new Archive(dir));
  assert.deepEqual(after.near('alpha', 'zeta', 10), before);
  assert.equal(after.phrase('gamma delta').length, 1, 'merged segment keeps cross-window phrases');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge errors use E_MERGE / E_WINDOW', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-merge-err-'));
  buildArchive(dir);
  const archive = new Archive(dir);
  assert.throws(() => archive.merge(1, 2), (e) => e instanceof ArchiveError && e.code === 'E_MERGE');
  assert.throws(() => archive.merge(4, 1), (e) => e instanceof ArchiveError && e.code === 'E_WINDOW');
  fs.rmSync(dir, { recursive: true, force: true });
});

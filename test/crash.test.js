import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLocalOps, status } from '../src/store.js';
import { freshStore, tmpdir } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const BATCH_KEYS = ['c1', 'c2', 'c3', 'c4', 'c5'];

function makeSourceStore() {
  const src = freshStore('SRC');
  applyLocalOps(src, BATCH_KEYS.map((k, i) => ({ kind: 'put', key: k, value: i })));
  return src;
}

async function waitForFile(file, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for marker ${file}`);
}

// Start a merge, wait until the child reaches the requested crash-injection
// point (signalled via a marker file), then SIGKILL it. The child parks at
// the injection point for 30s, so the kill is deterministic.
function killMergeAt(target, source, point) {
  return new Promise((resolve, reject) => {
    const markDir = tmpdir('obs-mark-');
    const delayEnv = {
      'pre-write': 'OBS_DEBUG_PRE_WRITE_DELAY_MS',
      'mid-write': 'OBS_DEBUG_MID_WRITE_DELAY_MS',
      'pre-fsync': 'OBS_DEBUG_PRE_FSYNC_DELAY_MS',
    }[point];
    const child = spawn(process.execPath, [CLI, 'merge', '--dir', target, '--other', source], {
      env: { ...process.env, OBS_DEBUG_MARK_DIR: markDir, [delayEnv]: '30000' },
      stdio: 'ignore',
    });
    child.on('error', reject);
    waitForFile(path.join(markDir, point))
      .then(() => {
        child.kill('SIGKILL');
      })
      .catch(reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function visibleBatchKeys(dir) {
  return Object.keys(status(dir).records).filter((k) => BATCH_KEYS.includes(k)).sort();
}

test('acceptance 4: kill before log write leaves no trace of the batch', async () => {
  const src = makeSourceStore();
  const dst = freshStore('DST');
  const { signal } = await killMergeAt(dst, src, 'pre-write');
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual(visibleBatchKeys(dst), []);
});

test('acceptance 4: kill mid-write (torn batch, no commit) is fully discarded', async () => {
  const src = makeSourceStore();
  const dst = freshStore('DST');
  const { signal } = await killMergeAt(dst, src, 'mid-write');
  assert.equal(signal, 'SIGKILL');
  // Partial bytes may sit in the log, but without a commit record the batch
  // must be invisible as a whole.
  assert.deepEqual(visibleBatchKeys(dst), []);
  // The store still works afterwards.
  applyLocalOps(dst, [{ kind: 'put', key: 'after-crash', value: 1 }]);
  assert.deepEqual(status(dst).records['after-crash'].value, 1);
});

test('acceptance 4: kill after write but before fsync exposes the whole batch or nothing', async () => {
  const src = makeSourceStore();
  const dst = freshStore('DST');
  const { signal } = await killMergeAt(dst, src, 'pre-fsync');
  assert.equal(signal, 'SIGKILL');
  const visible = visibleBatchKeys(dst);
  assert.ok(
    visible.length === 0 || visible.length === BATCH_KEYS.length,
    `batch must be all-or-nothing, got ${visible.length} keys`,
  );
  // The write completed before the kill, so the whole batch is visible.
  assert.deepEqual(visible, BATCH_KEYS);
});

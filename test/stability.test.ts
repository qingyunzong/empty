import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFileStable, scanDirectory, type HashDeps } from '../src/scanner.js';

test('hashFileStable retries while the file changes, then succeeds once stable', async () => {
  const changing = { size: 3, mtimeMs: 1, ctimeMs: 1, ino: 1 };
  const settled = { size: 3, mtimeMs: 2, ctimeMs: 2, ino: 1 };
  // Attempt 1 sees before=changing, after=settled (raced a writer).
  // Attempt 2 sees settled on both sides.
  const sequence = [changing, settled, settled, settled];
  let statCalls = 0;
  const deps: HashDeps = {
    stat: async () => sequence[Math.min(statCalls++, sequence.length - 1)],
    readFile: async () => new Uint8Array([1, 2, 3]),
  };
  const result = await hashFileStable('fake', 3, 0, deps);
  equal(result.stable, true);
  equal(statCalls, 4, 'two attempts, two stats each');
  equal(result.evidence.mtimeMs, settled.mtimeMs);
});

test('hashFileStable flags unstable after exhausting the retry budget', async () => {
  let tick = 0;
  const deps: HashDeps = {
    stat: async () => ({ size: 3, mtimeMs: ++tick, ctimeMs: tick, ino: 1 }),
    readFile: async () => new Uint8Array([9]),
  };
  const result = await hashFileStable('fake', 3, 0, deps);
  equal(result.stable, false);
  equal(tick, 6, 'exactly `retries` attempts were made');
});

test('a file modified concurrently during a real scan is flagged unstable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diridx-churn-'));
  const file = join(root, 'churn.bin');
  await writeFile(file, 'x'.repeat(1024 * 1024));
  const timer = setInterval(() => {
    appendFile(file, 'y').catch(() => {});
  }, 1);
  try {
    const manifest = await scanDirectory(root, { retries: 3, retryDelayMs: 5 });
    const entry = manifest.entries.find((candidate) => candidate.path === 'churn.bin');
    ok(entry !== undefined);
    equal(entry.unstable, true, 'continuously appended file is marked unstable');
  } finally {
    clearInterval(timer);
    await rm(root, { recursive: true, force: true });
  }
});

test('a quiet file is hashed once and reported stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diridx-quiet-'));
  await writeFile(join(root, 'quiet.txt'), 'still');
  try {
    const manifest = await scanDirectory(root);
    const entry = manifest.entries.find((candidate) => candidate.path === 'quiet.txt');
    ok(entry !== undefined);
    equal(entry.unstable, undefined);
    ok(entry.hash !== undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

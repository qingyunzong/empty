import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory, type HashDeps } from '../src/scanner.js';
import { compareManifests } from '../src/manifest.js';
import { loadCache, saveCache } from '../src/cache.js';

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'diridx-cache-'));
  await writeFile(join(root, 'data.txt'), 'payload');
  return root;
}

test('cache is reused only when content evidence matches (unchanged files are not re-read)', async () => {
  const root = await makeRoot();
  const cacheFile = root + '.cache.json';
  try {
    const baseline = await scanDirectory(root);
    await saveCache(cacheFile, baseline);

    // Any attempt to re-read file content fails loudly, so a successful scan
    // proves the cached hash was reused without touching the file.
    const forbiddingDeps: HashDeps = {
      stat: lstat,
      readFile: async () => {
        throw new Error('cached file must not be re-read');
      },
    };
    const cache = await loadCache(cacheFile);
    ok(cache !== undefined, 'cache file loads');
    const rescanned = await scanDirectory(root, { cache, hashDeps: forbiddingDeps });
    ok(compareManifests(baseline, rescanned).equal, 'cached rescan is equal');

    // Control: without a cache the file content is read exactly once.
    let controlReads = 0;
    const countingDeps: HashDeps = {
      stat: lstat,
      readFile: async (path: string) => {
        controlReads++;
        return readFile(path);
      },
    };
    await scanDirectory(root, { hashDeps: countingDeps });
    equal(controlReads, 1, 'control scan without cache reads the file');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cacheFile, { force: true });
  }
});

test('controlled modification never reports false equality', async () => {
  const root = await makeRoot();
  const cacheFile = root + '.cache.json';
  try {
    const baseline = await scanDirectory(root);
    await saveCache(cacheFile, baseline);
    const file = join(root, 'data.txt');

    // Case 1: same-size rewrite with the mtime forged back to the baseline.
    // ctime/ino evidence cannot be forged, so the cache must miss and the
    // new hash must be detected.
    const evidence = baseline.entries.find((entry) => entry.path === 'data.txt')?.evidence;
    ok(evidence !== undefined);
    await writeFile(file, 'PAYLOAD'); // same length, different content
    const forged = new Date(evidence.mtimeMs);
    await utimes(file, forged, forged);
    const afterForged = await scanDirectory(root, { cache: await loadCache(cacheFile) });
    const diffForged = compareManifests(baseline, afterForged);
    ok(!diffForged.equal, 'same-size edit with restored mtime is detected');
    equal(diffForged.changed.length, 1);
    equal(diffForged.changed[0].path, 'data.txt');

    // Case 2: content growth changes the size evidence.
    await writeFile(file, 'payload-with-more');
    const afterAppend = await scanDirectory(root, { cache: await loadCache(cacheFile) });
    const diffAppend = compareManifests(baseline, afterAppend);
    ok(!diffAppend.equal, 'size-changing edit is detected');
    equal(diffAppend.changed[0].path, 'data.txt');

    // Case 3: added and removed files are detected.
    await writeFile(file, 'payload');
    const restored = await scanDirectory(root, { cache: await loadCache(cacheFile) });
    ok(compareManifests(baseline, restored).equal, 'restored content compares equal again');
    await writeFile(join(root, 'extra.txt'), 'new');
    const withExtra = await scanDirectory(root, { cache: await loadCache(cacheFile) });
    const diffAdded = compareManifests(baseline, withExtra);
    equal(diffAdded.added.length, 1);
    equal(diffAdded.added[0].path, 'extra.txt');
    await rm(join(root, 'extra.txt'));
    await rm(file);
    const withMissing = await scanDirectory(root, { cache: await loadCache(cacheFile) });
    const diffRemoved = compareManifests(baseline, withMissing);
    equal(diffRemoved.removed.length, 1);
    equal(diffRemoved.removed[0].path, 'data.txt');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cacheFile, { force: true });
  }
});

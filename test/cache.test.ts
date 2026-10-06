import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonHashCache } from "../src/cache";
import { canonicalize, diffManifests } from "../src/manifest";
import { scanDirectory } from "../src/scanner";
import { makeFixture } from "./helpers";

test("cache is reused only while content evidence matches", async () => {
  const fixture = await makeFixture();
  const cacheDir = await mkdtemp(join(tmpdir(), "dirscan-cache-"));
  try {
    const cacheFile = join(cacheDir, "cache.json");

    const coldCache = await JsonHashCache.load(cacheFile, fixture.root);
    const first = await scanDirectory(fixture.root, { cache: coldCache });
    assert.equal(first.stats.hashed, 2);
    assert.equal(first.stats.cacheHits, 0);
    await coldCache.save(cacheFile);

    const warmCache = await JsonHashCache.load(cacheFile, fixture.root);
    const second = await scanDirectory(fixture.root, { cache: warmCache });
    assert.equal(second.stats.cacheHits, 2);
    assert.equal(second.stats.hashed, 0);
    assert.equal(canonicalize(first.manifest), canonicalize(second.manifest));

    // A content edit changes the evidence: the entry is re-hashed, others still hit.
    await writeFile(join(fixture.root, "alpha.txt"), "hello alpha, longer now");
    const third = await scanDirectory(fixture.root, { cache: warmCache });
    assert.equal(third.stats.hashed, 1);
    assert.equal(third.stats.cacheHits, 1);
    const diff = diffManifests(first.manifest, third.manifest);
    assert.equal(diff.equal, false);
    assert.deepEqual(diff.changed.map((change) => change.path), ["alpha.txt"]);
  } finally {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("same-size edits with restored mtime still invalidate the cache (no false equality)", async () => {
  const fixture = await makeFixture();
  const cacheDir = await mkdtemp(join(tmpdir(), "dirscan-cache-"));
  try {
    const cache = await JsonHashCache.load(join(cacheDir, "cache.json"), fixture.root);
    const before = await scanDirectory(fixture.root, { cache });

    const alphaPath = join(fixture.root, "alpha.txt");
    const beforeStats = await lstat(alphaPath);
    // Same-length edit, then restore mtime to try to fool a naive cache.
    await writeFile(alphaPath, "HELLO ALPHA");
    await utimes(alphaPath, beforeStats.atime, beforeStats.mtime);

    const after = await scanDirectory(fixture.root, { cache });
    const diff = diffManifests(before.manifest, after.manifest);
    assert.equal(diff.equal, false);
    assert.deepEqual(diff.changed.map((change) => change.path), ["alpha.txt"]);
    const alpha = after.manifest.entries.find((entry) => entry.path === "alpha.txt");
    assert.equal(alpha?.sha256, createHash("sha256").update("HELLO ALPHA").digest("hex"));
    // ctime (kernel-maintained) caught the edit; untouched files still hit the cache.
    assert.equal(after.stats.cacheHits, 1);
  } finally {
    await fixture.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("a cache written for a different root is ignored", async () => {
  const fixtureA = await makeFixture();
  const fixtureB = await makeFixture();
  const cacheDir = await mkdtemp(join(tmpdir(), "dirscan-cache-"));
  try {
    const cacheFile = join(cacheDir, "cache.json");
    const cacheA = await JsonHashCache.load(cacheFile, fixtureA.root);
    await scanDirectory(fixtureA.root, { cache: cacheA });
    await cacheA.save(cacheFile);

    const cacheB = await JsonHashCache.load(cacheFile, fixtureB.root);
    const scan = await scanDirectory(fixtureB.root, { cache: cacheB });
    assert.equal(scan.stats.cacheHits, 0);
    assert.equal(scan.stats.hashed, 2);
  } finally {
    await fixtureA.cleanup();
    await fixtureB.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

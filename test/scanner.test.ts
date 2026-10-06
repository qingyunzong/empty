import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalize } from "../src/manifest";
import { FsIo, realFs, scanDirectory, StatsLike } from "../src/scanner";
import { makeFixture } from "./helpers";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function wrapLstat(mutate: (path: string, stats: StatsLike) => StatsLike): FsIo {
  return {
    ...realFs,
    lstat: async (path: string) => mutate(path, await realFs.lstat(path)),
  };
}

function withMtime(stats: StatsLike, mtimeMs: number): StatsLike {
  return {
    isFile: () => stats.isFile(),
    isDirectory: () => stats.isDirectory(),
    isSymbolicLink: () => stats.isSymbolicLink(),
    size: stats.size,
    ino: stats.ino,
    mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

test("manifest records relative paths, types and sha256 hashes", async () => {
  const fixture = await makeFixture();
  try {
    const { manifest } = await scanDirectory(fixture.root);
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const alpha = byPath.get("alpha.txt");
    assert.equal(alpha?.type, "file");
    assert.equal(alpha?.size, "hello alpha".length);
    assert.equal(alpha?.sha256, sha256("hello alpha"));
    assert.equal(alpha?.unstable, undefined);
    assert.equal(byPath.get("sub")?.type, "directory");
    assert.equal(byPath.get("sub/empty")?.type, "directory");
    assert.equal(byPath.get("sub/beta.txt")?.sha256, sha256("hello beta"));
  } finally {
    await fixture.cleanup();
  }
});

test("symlinks are recorded but never followed", async () => {
  const fixture = await makeFixture();
  const outside = await mkdtemp(join(tmpdir(), "dirscan-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(fixture.root, "escape"));
    const { manifest } = await scanDirectory(fixture.root);
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));

    const link = byPath.get("link-to-alpha");
    assert.equal(link?.type, "symlink");
    assert.equal(link?.target, "alpha.txt");
    assert.equal(link?.sha256, undefined);
    assert.equal(byPath.get("link-to-sub")?.type, "symlink");
    assert.equal(byPath.get("broken-link")?.type, "symlink");
    assert.equal(byPath.get("escape")?.type, "symlink");

    // Directory symlink is not traversed; outside content is never hashed.
    assert.ok(!byPath.has("link-to-sub/beta.txt"));
    const secretHash = sha256("top secret");
    assert.ok(!manifest.entries.some((entry) => entry.sha256 === secretHash));
  } finally {
    await fixture.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("repeated scans produce byte-identical canonical manifests", async () => {
  const fixture = await makeFixture();
  try {
    const first = await scanDirectory(fixture.root);
    const second = await scanDirectory(fixture.root);
    assert.equal(canonicalize(first.manifest), canonicalize(second.manifest));
  } finally {
    await fixture.cleanup();
  }
});

test("a file that keeps changing is retried a limited number of times and marked unstable", async () => {
  const fixture = await makeFixture();
  try {
    let lstatCalls = 0;
    const io = wrapLstat((path, stats) => {
      if (!path.endsWith("alpha.txt")) return stats;
      lstatCalls++;
      return withMtime(stats, stats.mtimeMs + lstatCalls);
    });
    const retries = 2;
    const { manifest, stats } = await scanDirectory(fixture.root, { io, retries });
    const alpha = manifest.entries.find((entry) => entry.path === "alpha.txt");
    assert.equal(alpha?.unstable, true);
    assert.equal(stats.unstable, 1);
    // One lstat from the directory walk plus two per hashing attempt.
    assert.equal(lstatCalls, 1 + 2 * (retries + 1));
    assert.equal(stats.retries, retries + 1);
    // The last observed hash is still recorded for visibility.
    assert.match(alpha?.sha256 ?? "", /^[0-9a-f]{64}$/);
  } finally {
    await fixture.cleanup();
  }
});

test("a file that stabilizes within the retry budget is hashed normally", async () => {
  const fixture = await makeFixture();
  try {
    let lstatCalls = 0;
    const io = wrapLstat((path, stats) => {
      if (!path.endsWith("alpha.txt")) return stats;
      lstatCalls++;
      // The first three observations differ, then the file "stabilizes".
      const bump = lstatCalls <= 3 ? lstatCalls : 0;
      return withMtime(stats, stats.mtimeMs + bump);
    });
    const { manifest, stats } = await scanDirectory(fixture.root, { io, retries: 3 });
    const alpha = manifest.entries.find((entry) => entry.path === "alpha.txt");
    assert.equal(alpha?.unstable, undefined);
    assert.equal(alpha?.sha256, sha256("hello alpha"));
    assert.equal(stats.unstable, 0);
    assert.ok(stats.retries >= 1);
    assert.equal(stats.hashed, 2);
  } finally {
    await fixture.cleanup();
  }
});

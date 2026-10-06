import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeFixture } from "./helpers";

const CLI = join(__dirname, "..", "src", "cli.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : 0;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test("cli scan/diff: controlled modification is reported, never false equality", async () => {
  const fixture = await makeFixture();
  const workDir = await mkdtemp(join(tmpdir(), "dirscan-cli-"));
  try {
    const cacheFile = join(workDir, "cache.json");
    const manifestA = join(workDir, "a.json");
    const manifestB = join(workDir, "b.json");

    const scanA = await runCli(["scan", fixture.root, "--cache", cacheFile, "--out", manifestA]);
    assert.equal(scanA.code, 0, scanA.stderr);

    await writeFile(join(fixture.root, "sub", "beta.txt"), "hello beta, modified");

    const scanB = await runCli(["scan", fixture.root, "--cache", cacheFile, "--out", manifestB]);
    assert.equal(scanB.code, 0, scanB.stderr);

    const diff = await runCli(["diff", manifestA, manifestB]);
    assert.equal(diff.code, 1);
    assert.match(diff.stdout, /~ sub\/beta\.txt \[size, sha256\]/);

    const same = await runCli(["diff", manifestA, manifestA]);
    assert.equal(same.code, 0);
    assert.match(same.stdout, /identical/);

    const parsed = JSON.parse(await readFile(manifestA, "utf8")) as {
      version: number;
      entries: Array<{ path: string; type: string }>;
    };
    assert.equal(parsed.version, 1);
    assert.ok(parsed.entries.some((entry) => entry.path === "sub/beta.txt"));
    assert.ok(parsed.entries.every((entry) => !entry.path.startsWith("/")));
  } finally {
    await fixture.cleanup();
    await rm(workDir, { recursive: true, force: true });
  }
});

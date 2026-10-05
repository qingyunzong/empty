import { deepEqual, equal, rejects } from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStorageAdapter } from "../src/fileStorage.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-export-fs-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("中间暂存不可读：权限位 0o000，发布前无法读取", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "out.jsonl");
    const storage = new FileStorageAdapter();
    const staging = await storage.writeStaging(target, "secret\n");

    const st = await stat(staging.stagingPath);
    equal(st.mode & 0o777, 0o000);
    if (process.getuid === undefined || process.getuid() !== 0) {
      await rejects(readFile(staging.stagingPath, "utf8"));
    }

    await storage.publish(staging);
    equal(await readFile(target, "utf8"), "secret\n");
    const published = await stat(target);
    equal(published.mode & 0o777, 0o644);
    deepEqual((await readdir(dir)).sort(), ["out.jsonl"]);
  });
});

test("discard 删除暂存，目标路径从不出现", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "out.jsonl");
    const storage = new FileStorageAdapter();
    const staging = await storage.writeStaging(target, "data\n");

    await storage.discard(staging);
    await rejects(stat(staging.stagingPath));
    await rejects(stat(target));
    deepEqual(await readdir(dir), []);
  });
});

test("publish 原子替换已存在的旧文件", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "out.jsonl");
    await writeFile(target, "old\n");
    const storage = new FileStorageAdapter();
    const staging = await storage.writeStaging(target, "new\n");

    await storage.publish(staging);
    equal(await readFile(target, "utf8"), "new\n");
    deepEqual((await readdir(dir)).sort(), ["out.jsonl"]);
  });
});

import { deepEqual, equal, rejects } from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportFile } from "../src/exporter.js";
import { FileStorageAdapter } from "../src/fileStorage.js";
import { MemoryDataSource, MemoryPermissionAdapter } from "../src/memory.js";
import { renderExport } from "../src/render.js";
import { PermissionRevokedError } from "../src/types.js";
import type { SnapshotRow, StagingHandle, StorageAdapter } from "../src/types.js";

const ROWS: readonly SnapshotRow[] = [
  { id: "row-a", permissionGeneration: 3, payload: "alpha" },
  { id: "row-b", permissionGeneration: 7, payload: "beta" },
  { id: "row-c", permissionGeneration: 1, payload: "gamma" },
];

/** 注入适配器：暂存写入期间撤销指定行的权限（模拟导出进行中发生权限变化）。 */
class RevokingStorage implements StorageAdapter {
  constructor(
    private readonly inner: StorageAdapter,
    private readonly permissions: MemoryPermissionAdapter,
    private readonly rowIds: readonly string[],
  ) {}

  async writeStaging(targetPath: string, content: string): Promise<StagingHandle> {
    const handle = await this.inner.writeStaging(targetPath, content);
    for (const id of this.rowIds) {
      this.permissions.revoke(id);
    }
    return handle;
  }

  publish(staging: StagingHandle): Promise<void> {
    return this.inner.publish(staging);
  }

  discard(staging: StagingHandle): Promise<void> {
    return this.inner.discard(staging);
  }
}

/** 注入适配器：publish 时失败（模拟磁盘/网络故障）。 */
class FailingPublishStorage implements StorageAdapter {
  constructor(
    private readonly inner: StorageAdapter,
    private readonly failure: Error,
  ) {}

  writeStaging(targetPath: string, content: string): Promise<StagingHandle> {
    return this.inner.writeStaging(targetPath, content);
  }

  publish(): Promise<void> {
    return Promise.reject(this.failure);
  }

  discard(staging: StagingHandle): Promise<void> {
    return this.inner.discard(staging);
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-export-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function leftoverFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

test("全部权限代一致时原子发布，内容来自固定快照", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "report.jsonl");
    const dataSource = new MemoryDataSource(ROWS);
    const permissions = new MemoryPermissionAdapter(ROWS);
    const result = await exportFile(
      { dataSource, permissions, storage: new FileStorageAdapter() },
      target,
    );
    equal(result.rowCount, 3);
    equal(await readFile(target, "utf8"), renderExport(ROWS));
    deepEqual(await leftoverFiles(dir), ["report.jsonl"]);
  });
});

test("发布前任何权限撤销使全文件不发布，旧文件不变，暂存清理", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "report.jsonl");
    await writeFile(target, "OLD-CONTENT\n");
    const dataSource = new MemoryDataSource(ROWS);
    const permissions = new MemoryPermissionAdapter(ROWS);
    const storage = new RevokingStorage(new FileStorageAdapter(), permissions, ["row-b"]);

    await rejects(
      exportFile({ dataSource, permissions, storage }, target),
      (err) =>
        err instanceof PermissionRevokedError &&
        err.revokedRowIds.length === 1 &&
        err.revokedRowIds[0] === "row-b",
    );
    equal(await readFile(target, "utf8"), "OLD-CONTENT\n");
    deepEqual(await leftoverFiles(dir), ["report.jsonl"]);
  });
});

test("复核不短路：多个撤销行全部收集", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "report.jsonl");
    const dataSource = new MemoryDataSource(ROWS);
    const permissions = new MemoryPermissionAdapter(ROWS);
    const storage = new RevokingStorage(new FileStorageAdapter(), permissions, ["row-a", "row-c"]);

    await rejects(
      exportFile({ dataSource, permissions, storage }, target),
      (err) =>
        err instanceof PermissionRevokedError &&
        err.revokedRowIds.length === 2 &&
        err.revokedRowIds[0] === "row-a" &&
        err.revokedRowIds[1] === "row-c",
    );
    deepEqual(await leftoverFiles(dir), []);
  });
});

test("发布失败时旧文件不变，暂存清理", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "report.jsonl");
    await writeFile(target, "OLD-CONTENT\n");
    const dataSource = new MemoryDataSource(ROWS);
    const permissions = new MemoryPermissionAdapter(ROWS);
    const storage = new FailingPublishStorage(new FileStorageAdapter(), new Error("disk full"));

    await rejects(
      exportFile({ dataSource, permissions, storage }, target),
      (err) => err instanceof Error && err.message === "disk full",
    );
    equal(await readFile(target, "utf8"), "OLD-CONTENT\n");
    deepEqual(await leftoverFiles(dir), ["report.jsonl"]);
  });
});

test("导出期间源数据被修改，发布内容仍为开始时的固定快照", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "report.jsonl");
    const dataSource = new MemoryDataSource(ROWS);
    const permissions = new MemoryPermissionAdapter(ROWS);
    const mutating: StorageAdapter = {
      async writeStaging(p, c) {
        const handle = await new FileStorageAdapter().writeStaging(p, c);
        dataSource.mutate("row-a", "tampered");
        return handle;
      },
      publish: (s) => new FileStorageAdapter().publish(s),
      discard: (s) => new FileStorageAdapter().discard(s),
    };

    await exportFile({ dataSource, permissions, storage: mutating }, target);
    equal(await readFile(target, "utf8"), renderExport(ROWS));
  });
});

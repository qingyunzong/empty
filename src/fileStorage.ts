import { randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { StagingHandle, StorageAdapter } from "./types.js";

/**
 * 基于本地文件系统的存储适配器（仅 Node 内置库）：
 * - 暂存文件以 0o000 创建：任何后续 open 均被拒绝，中间暂存不可读；
 *   当前 fd 在 open 时已获得写权限，可继续写入并 fsync。
 * - 发布 = chmod 为最终权限 + rename 原子替换目标文件 + fsync 目录。
 * - 丢弃 = 删除暂存（unlink 不依赖文件自身权限位），目标路径不受影响。
 */
export class FileStorageAdapter implements StorageAdapter {
  constructor(private readonly finalMode: number = 0o644) {}

  async writeStaging(targetPath: string, content: string): Promise<StagingHandle> {
    const stagingPath = `${targetPath}.stage-${randomUUID()}`;
    const handle = await open(stagingPath, "wx", 0o000);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await rm(stagingPath, { force: true }).catch(() => {});
      throw err;
    }
    await handle.close();
    return { stagingPath, targetPath };
  }

  async publish(staging: StagingHandle): Promise<void> {
    await chmod(staging.stagingPath, this.finalMode);
    await rename(staging.stagingPath, staging.targetPath);
    const dir = await open(dirname(staging.targetPath), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  async discard(staging: StagingHandle): Promise<void> {
    await rm(staging.stagingPath, { force: true });
  }
}

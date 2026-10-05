import { renderExport } from "./render.js";
import { PermissionRevokedError } from "./types.js";
import type { DataSourceAdapter, PermissionAdapter, StorageAdapter } from "./types.js";

export interface ExportDeps {
  readonly dataSource: DataSourceAdapter;
  readonly permissions: PermissionAdapter;
  readonly storage: StorageAdapter;
}

export interface ExportResult {
  readonly targetPath: string;
  readonly rowCount: number;
  readonly bytes: number;
}

/**
 * 导出流程：
 * 1. 开始时固定数据快照；
 * 2. 渲染并写入不可读的中间暂存；
 * 3. 发布前重新核验全部涉及行的权限代（不短路，收集所有撤销行）；
 * 4. 任何撤销 → 丢弃暂存，全文件不发布，旧文件不变；
 * 5. 全部一致 → 原子发布；发布失败同样丢弃暂存，旧文件不变。
 */
export async function exportFile(deps: ExportDeps, targetPath: string): Promise<ExportResult> {
  const snapshot = await deps.dataSource.snapshot();
  const rows = snapshot.rows;
  const content = renderExport(rows);

  const staging = await deps.storage.writeStaging(targetPath, content);
  try {
    const revoked: string[] = [];
    for (const row of rows) {
      const current = await deps.permissions.getPermissionGeneration(row.id);
      if (current === null || current !== row.permissionGeneration) {
        revoked.push(row.id);
      }
    }
    if (revoked.length > 0) {
      throw new PermissionRevokedError(revoked);
    }
    await deps.storage.publish(staging);
    return { targetPath, rowCount: rows.length, bytes: Buffer.byteLength(content) };
  } catch (err) {
    await deps.storage.discard(staging).catch(() => {});
    throw err;
  }
}

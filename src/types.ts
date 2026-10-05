/** 快照中的一行数据，permissionGeneration 为导出开始时固定下来的权限代。 */
export interface SnapshotRow {
  readonly id: string;
  readonly permissionGeneration: number;
  readonly payload: string;
}

/** 导出开始时取到的固定数据快照。 */
export interface Snapshot {
  readonly rows: readonly SnapshotRow[];
}

/** 数据来源适配器：在导出开始时返回一份固定快照。 */
export interface DataSourceAdapter {
  snapshot(): Promise<Snapshot>;
}

/** 权限适配器：发布前查询某行当前的权限代。 */
export interface PermissionAdapter {
  /** 返回该行当前的权限代；行已删除或完全不可见时返回 null。 */
  getPermissionGeneration(rowId: string): Promise<number | null>;
}

/** 暂存句柄：指向不可读的中间暂存。 */
export interface StagingHandle {
  readonly stagingPath: string;
  readonly targetPath: string;
}

/** 存储适配器：暂存写入、原子发布、丢弃清理。 */
export interface StorageAdapter {
  /** 将内容写入不可读的中间暂存（不得出现在目标路径）。 */
  writeStaging(targetPath: string, content: string): Promise<StagingHandle>;
  /** 将暂存原子发布到目标路径（替换旧文件）。 */
  publish(staging: StagingHandle): Promise<void>;
  /** 丢弃暂存；需幂等，目标路径保持不动。 */
  discard(staging: StagingHandle): Promise<void>;
}

/** 发布前复核发现权限代变化（撤销）时抛出，全文件不发布。 */
export class PermissionRevokedError extends Error {
  readonly revokedRowIds: readonly string[];

  constructor(revokedRowIds: readonly string[]) {
    super(`permission revoked for ${revokedRowIds.length} row(s): ${revokedRowIds.join(", ")}`);
    this.name = "PermissionRevokedError";
    this.revokedRowIds = revokedRowIds;
  }
}

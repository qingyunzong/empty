import type {
  DataSourceAdapter,
  PermissionAdapter,
  Snapshot,
  SnapshotRow,
} from "./types.js";

/** 内存数据源适配器：快照为深拷贝，之后的源数据变化不影响已固定的快照。 */
export class MemoryDataSource implements DataSourceAdapter {
  private rows: SnapshotRow[];

  constructor(rows: readonly SnapshotRow[]) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  /** 模拟导出期间上游数据被修改。 */
  mutate(rowId: string, payload: string): void {
    this.rows = this.rows.map((row) => (row.id === rowId ? { ...row, payload } : row));
  }

  snapshot(): Promise<Snapshot> {
    return Promise.resolve({ rows: this.rows.map((row) => ({ ...row })) });
  }
}

/** 内存权限适配器：权限代保存在可变 Map 中，revoke() 模拟撤销。 */
export class MemoryPermissionAdapter implements PermissionAdapter {
  private readonly generations = new Map<string, number>();

  constructor(rows: readonly SnapshotRow[]) {
    for (const row of rows) {
      this.generations.set(row.id, row.permissionGeneration);
    }
  }

  /** 撤销 = 权限代递增；删除行 = 行彻底不可见。 */
  revoke(rowId: string): void {
    this.generations.set(rowId, (this.generations.get(rowId) ?? 0) + 1);
  }

  remove(rowId: string): void {
    this.generations.delete(rowId);
  }

  getPermissionGeneration(rowId: string): Promise<number | null> {
    return Promise.resolve(this.generations.get(rowId) ?? null);
  }
}

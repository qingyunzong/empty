/** 单个文档条目：以稳定 id 标识，path 可变，fields 为文档字段集合。 */
export interface FileEntry {
  id: string;
  path: string;
  fields: Record<string, string>;
  /** 该侧快照中此条目的版本号，源版本变化即视为输入已变。 */
  version: number;
}

/** 一侧快照：id -> 条目。 */
export type Snapshot = Record<string, FileEntry>;

/** 合并结果中的文件（不带版本信息）。 */
export interface MergedFile {
  id: string;
  path: string;
  fields: Record<string, string>;
}

export function fieldsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function entriesEqual(a: FileEntry, b: FileEntry): boolean {
  return a.path === b.path && fieldsEqual(a.fields, b.fields);
}

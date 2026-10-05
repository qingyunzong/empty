/** A single row captured in the export snapshot. */
export interface ExportRow {
  readonly id: string;
  /** Permission epoch ("权限代") of the row at snapshot time. */
  readonly permissionEpoch: number;
  readonly payload: string;
}

/** An immutable view of the data fixed at the start of an export. */
export interface Snapshot {
  readonly snapshotId: string;
  readonly takenAt: number;
  readonly rows: readonly ExportRow[];
}

/** Provides the fixed data snapshot taken when an export begins. */
export interface SnapshotSource {
  beginSnapshot(): Promise<Snapshot>;
}

/** Authoritative source of current permission epochs, consulted right before publish. */
export interface PermissionAuthority {
  /** Returns the row's current permission epoch, or null if permission was revoked. */
  currentEpoch(rowId: string): Promise<number | null>;
}

/** A staged (intermediate, unreadable) export file awaiting commit or abort. */
export interface StagedFile {
  readonly stagingPath: string;
  /** Atomically publish the staged content to the target path. */
  commit(): Promise<void>;
  /** Discard the staged content; the previous target file stays untouched. */
  abort(): Promise<void>;
}

/** Writes export content to an unreadable staging location and publishes atomically. */
export interface Publisher {
  stage(targetPath: string, content: string): Promise<StagedFile>;
}

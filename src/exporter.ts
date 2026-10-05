import type {
  ExportRow,
  PermissionAuthority,
  Publisher,
  Snapshot,
  SnapshotSource,
} from "./types";
import { PermissionVerificationError } from "./errors";

export interface ExportOptions {
  /** Final destination path of the published file. */
  targetPath: string;
  /** Optional custom serializer; defaults to newline-delimited JSON. */
  serialize?: (rows: readonly ExportRow[], snapshot: Snapshot) => string;
}

export interface ExportResult {
  readonly snapshotId: string;
  readonly rowCount: number;
  readonly targetPath: string;
}

function defaultSerialize(rows: readonly ExportRow[], snapshot: Snapshot): string {
  const header = JSON.stringify({ snapshotId: snapshot.snapshotId, takenAt: snapshot.takenAt });
  const lines = rows.map((row) =>
    JSON.stringify({ id: row.id, permissionEpoch: row.permissionEpoch, payload: row.payload })
  );
  return [header, ...lines].join("\n") + "\n";
}

/**
 * Export flow:
 *   1. Fix a data snapshot at the start.
 *   2. Serialize and stage it to an unreadable intermediate location.
 *   3. Re-verify the permission epoch of every involved row.
 *   4. Any revocation/epoch change withholds the whole file; otherwise publish atomically.
 * On any failure the staging area is cleaned up and a pre-existing target file
 * is left byte-for-byte unchanged.
 */
export class Exporter {
  constructor(
    private readonly source: SnapshotSource,
    private readonly authority: PermissionAuthority,
    private readonly publisher: Publisher
  ) {}

  async export(options: ExportOptions): Promise<ExportResult> {
    const snapshot = await this.source.beginSnapshot();
    const serialize = options.serialize ?? defaultSerialize;
    const content = serialize(snapshot.rows, snapshot);

    const staged = await this.publisher.stage(options.targetPath, content);
    try {
      for (const row of snapshot.rows) {
        const current = await this.authority.currentEpoch(row.id);
        if (current === null) {
          throw new PermissionVerificationError(row.id, "revoked", row.permissionEpoch, null);
        }
        if (current !== row.permissionEpoch) {
          throw new PermissionVerificationError(row.id, "epoch-changed", row.permissionEpoch, current);
        }
      }
      await staged.commit();
      return {
        snapshotId: snapshot.snapshotId,
        rowCount: snapshot.rows.length,
        targetPath: options.targetPath,
      };
    } catch (err) {
      await staged.abort().catch(() => {});
      throw err;
    }
  }
}

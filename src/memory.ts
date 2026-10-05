import { randomUUID } from "node:crypto";
import type {
  ExportRow,
  PermissionAuthority,
  Snapshot,
  SnapshotSource,
} from "./types";

/**
 * In-memory snapshot source. `beginSnapshot` deep-copies the current rows so
 * later mutations of the source never leak into an in-flight export.
 */
export class MemorySnapshotSource implements SnapshotSource {
  private rows: ExportRow[];

  constructor(initialRows: readonly ExportRow[]) {
    this.rows = initialRows.map((row) => ({ ...row }));
  }

  /** Mutate the underlying rows (simulates concurrent writers). */
  mutate(fn: (rows: ExportRow[]) => ExportRow[]): void {
    this.rows = fn(this.rows.map((row) => ({ ...row })));
  }

  async beginSnapshot(): Promise<Snapshot> {
    return {
      snapshotId: randomUUID(),
      takenAt: Date.now(),
      rows: this.rows.map((row) => ({ ...row })),
    };
  }
}

/** In-memory permission authority; epochs can be changed or revoked at any time. */
export class MemoryPermissionAuthority implements PermissionAuthority {
  private readonly epochs = new Map<string, number | null>();

  constructor(entries: ReadonlyArray<readonly [string, number]>) {
    for (const [id, epoch] of entries) {
      this.epochs.set(id, epoch);
    }
  }

  setEpoch(rowId: string, epoch: number): void {
    this.epochs.set(rowId, epoch);
  }

  revoke(rowId: string): void {
    this.epochs.set(rowId, null);
  }

  async currentEpoch(rowId: string): Promise<number | null> {
    return this.epochs.has(rowId) ? (this.epochs.get(rowId) ?? null) : null;
  }
}

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import type { Batch, Snapshot, StorageAdapter } from "./types.js";

/**
 * Write boundaries of one atomic commit, in order. The commit point is
 * "rename": a crash before it leaves the old state intact; a crash at or
 * after it leaves the full batch durable.
 */
export const WRITE_BOUNDARIES = [
  "temp-write",
  "temp-fsync",
  "rename",
  "dir-fsync",
] as const;
export type WriteBoundary = (typeof WRITE_BOUNDARIES)[number];

export interface FileStorageOptions {
  /**
   * Optional hook invoked at every write boundary, before performing the
   * boundary's step. Used by tests to inject crashes / count boundaries.
   */
  onBoundary?: (boundary: WriteBoundary) => void;
}

const STATE_FILE = "state.json";
const TEMP_FILE = "state.json.tmp";

/**
 * File-backed storage adapter. Each batch (changes + cursor) is committed
 * atomically via write-to-temp, fsync, atomic rename, fsync-dir. On load,
 * a leftover temp file is an uncommitted batch and is discarded.
 */
export class FileStorageAdapter implements StorageAdapter {
  private readonly dir: string;
  private readonly onBoundary?: (boundary: WriteBoundary) => void;

  constructor(dir: string, options: FileStorageOptions = {}) {
    this.dir = dir;
    if (options.onBoundary !== undefined) this.onBoundary = options.onBoundary;
    mkdirSync(dir, { recursive: true });
  }

  private boundary(name: WriteBoundary): void {
    this.onBoundary?.(name);
  }

  load(): Snapshot {
    const tempPath = join(this.dir, TEMP_FILE);
    if (existsSync(tempPath)) {
      // Uncommitted batch from an interrupted commit: roll it back.
      rmSync(tempPath);
    }
    const statePath = join(this.dir, STATE_FILE);
    if (!existsSync(statePath)) {
      return { records: {}, cursor: null };
    }
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Snapshot;
    return { records: parsed.records, cursor: parsed.cursor };
  }

  commitBatch(batch: Batch): void {
    const current = this.load();
    const records: Record<string, string> = { ...current.records };
    for (const change of batch.changes) {
      records[change.id] = change.content;
    }
    const next: Snapshot = { records, cursor: batch.cursor };
    const payload = JSON.stringify(next);

    const tempPath = join(this.dir, TEMP_FILE);
    const statePath = join(this.dir, STATE_FILE);

    this.boundary("temp-write");
    writeFileSync(tempPath, payload, "utf8");

    this.boundary("temp-fsync");
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    this.boundary("rename");
    renameSync(tempPath, statePath);

    this.boundary("dir-fsync");
    const dirFd = openSync(this.dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

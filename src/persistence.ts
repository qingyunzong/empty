/**
 * Crash-safe snapshot persistence for the ranked library.
 *
 * save() writes the snapshot to a temporary file, fsyncs it, then atomically
 * renames it over snapshot.json. A crash can therefore leave either the old
 * or the new snapshot, never a torn one; a leftover .tmp file from a crashed
 * write is simply ignored by load(). The payload carries a SHA-256 checksum
 * so corruption of the committed file is detected instead of silently
 * restoring a different snapshot.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export class CorruptSnapshotError extends Error {}

export class SnapshotStore<T> {
  private readonly file: string;
  private readonly tmpFile: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "snapshot.json");
    this.tmpFile = join(dir, "snapshot.json.tmp");
  }

  save(data: T): void {
    const payload = JSON.stringify(data);
    const envelope = JSON.stringify({ payload, checksum: sha256(payload) });
    writeFileSync(this.tmpFile, envelope);
    const fd = openSync(this.tmpFile, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmpFile, this.file);
  }

  /** Returns the last committed snapshot, or null when none exists. */
  load(): T | null {
    if (!existsSync(this.file)) return null;
    const envelope = JSON.parse(readFileSync(this.file, "utf8")) as {
      payload: string;
      checksum: string;
    };
    if (sha256(envelope.payload) !== envelope.checksum) {
      throw new CorruptSnapshotError(`checksum mismatch in ${this.file}`);
    }
    return JSON.parse(envelope.payload) as T;
  }
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

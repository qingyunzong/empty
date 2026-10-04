import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * A versioned view over input files. Every distinct content of a path must
 * yield a distinct, comparable version string. The build cache re-checks
 * versions before publishing task results, so versions must be cheap to
 * re-read and must change whenever the content changes.
 */
export interface FileStore {
  /** Current version of `path`, or a stable sentinel when it does not exist. */
  version(path: string): string;
  /** Current content of `path`. Throws when the file does not exist. */
  read(path: string): string;
  exists(path: string): boolean;
}

export const MISSING_VERSION = "<missing>";

/** In-memory store with a monotonic per-file version counter. */
export class MemoryFileStore implements FileStore {
  private files = new Map<string, { content: string; version: number }>();

  write(path: string, content: string): void {
    const prev = this.files.get(path);
    this.files.set(path, { content, version: (prev?.version ?? 0) + 1 });
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  version(path: string): string {
    const entry = this.files.get(path);
    return entry ? `v${entry.version}` : MISSING_VERSION;
  }

  read(path: string): string {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`file not found: ${path}`);
    return entry.content;
  }
}

/** Real-file-system store. Versions are content hashes, so they are exact. */
export class FsFileStore implements FileStore {
  exists(path: string): boolean {
    return existsSync(path);
  }

  version(path: string): string {
    if (!existsSync(path)) return MISSING_VERSION;
    const hash = createHash("sha1");
    hash.update(readFileSync(path, "utf8"));
    return `sha1:${hash.digest("hex")}`;
  }

  read(path: string): string {
    return readFileSync(path, "utf8");
  }
}

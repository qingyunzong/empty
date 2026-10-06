import { createHash } from "node:crypto";
import {
  lstat as fsLstat,
  readdir as fsReaddir,
  readlink as fsReadlink,
  readFile as fsReadFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Manifest, ManifestEntry } from "./types";

export interface StatsLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface FsIo {
  lstat(path: string): Promise<StatsLike>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
}

export const realFs: FsIo = {
  lstat: fsLstat,
  readdir: fsReaddir,
  readlink: fsReadlink,
  readFile: fsReadFile,
};

/**
 * Content evidence: a cached hash is reused only when every field matches the
 * current lstat. ctime is included deliberately: it is kernel-maintained and
 * cannot be forged with utimes(2), so restoring mtime after an edit still
 * invalidates the cache and no false equality is reported.
 */
export interface FileEvidence {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface CacheRecord extends FileEvidence {
  sha256: string;
}

export interface HashCache {
  get(relPath: string): CacheRecord | undefined;
  set(relPath: string, record: CacheRecord): void;
}

export function evidenceOf(stats: StatsLike): FileEvidence {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino };
}

export function evidenceEquals(a: FileEvidence, b: FileEvidence): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

export interface ScanOptions {
  /** Stability re-checks per file before it is marked unstable. Default 3. */
  retries?: number;
  cache?: HashCache;
  /** Injectable filesystem, mainly for tests. Defaults to real fs. */
  io?: FsIo;
  /** Root-relative POSIX paths to skip (e.g. the cache file itself). */
  excludePaths?: ReadonlySet<string>;
}

export interface ScanStats {
  hashed: number;
  cacheHits: number;
  retries: number;
  unstable: number;
}

export interface ScanResult {
  manifest: Manifest;
  stats: ScanStats;
}

export const DEFAULT_RETRIES = 3;

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function scanDirectory(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const io = options.io ?? realFs;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const cache = options.cache;
  const exclude = options.excludePaths;
  const stats: ScanStats = { hashed: 0, cacheHits: 0, retries: 0, unstable: 0 };
  const entries: ManifestEntry[] = [];

  async function hashFile(
    absPath: string,
    relPath: string
  ): Promise<{ sha256: string | null; unstable: boolean; evidence: FileEvidence | null }> {
    let lastHash: string | null = null;
    let lastEvidence: FileEvidence | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let before: StatsLike;
      try {
        before = await io.lstat(absPath);
      } catch {
        stats.retries++;
        continue;
      }
      if (!before.isFile()) {
        stats.retries++;
        continue;
      }
      const beforeEvidence = evidenceOf(before);
      if (cache) {
        const hit = cache.get(relPath);
        if (hit && evidenceEquals(hit, beforeEvidence)) {
          stats.cacheHits++;
          return { sha256: hit.sha256, unstable: false, evidence: beforeEvidence };
        }
      }
      let content: Buffer;
      try {
        content = await io.readFile(absPath);
      } catch {
        stats.retries++;
        continue;
      }
      let after: StatsLike;
      try {
        after = await io.lstat(absPath);
      } catch {
        stats.retries++;
        continue;
      }
      const afterEvidence = evidenceOf(after);
      if (!after.isFile() || !evidenceEquals(beforeEvidence, afterEvidence)) {
        stats.retries++;
        lastHash = sha256Hex(content);
        lastEvidence = afterEvidence;
        continue;
      }
      const hash = sha256Hex(content);
      stats.hashed++;
      if (cache) cache.set(relPath, { ...afterEvidence, sha256: hash });
      return { sha256: hash, unstable: false, evidence: afterEvidence };
    }
    stats.unstable++;
    return { sha256: lastHash, unstable: true, evidence: lastEvidence };
  }

  async function walk(absDir: string, relDir: string): Promise<void> {
    const names = (await io.readdir(absDir)).sort(comparePaths);
    for (const name of names) {
      const abs = join(absDir, name);
      const rel = relDir === "" ? name : relDir + "/" + name;
      if (exclude && exclude.has(rel)) continue;
      let statsForEntry: StatsLike;
      try {
        statsForEntry = await io.lstat(abs);
      } catch {
        entries.push({ path: rel, type: "other", unstable: true });
        stats.unstable++;
        continue;
      }
      if (statsForEntry.isDirectory()) {
        entries.push({ path: rel, type: "directory" });
        await walk(abs, rel);
      } else if (statsForEntry.isSymbolicLink()) {
        const entry: ManifestEntry = { path: rel, type: "symlink" };
        try {
          entry.target = await io.readlink(abs);
        } catch {
          entry.unstable = true;
          stats.unstable++;
        }
        entries.push(entry);
      } else if (statsForEntry.isFile()) {
        const result = await hashFile(abs, rel);
        const entry: ManifestEntry = { path: rel, type: "file" };
        if (result.evidence) entry.size = result.evidence.size;
        entry.sha256 = result.sha256;
        if (result.unstable) entry.unstable = true;
        entries.push(entry);
      } else {
        entries.push({ path: rel, type: "other" });
      }
    }
  }

  await walk(root, "");
  entries.sort((a, b) => comparePaths(a.path, b.path));
  return { manifest: { version: 1, entries }, stats };
}

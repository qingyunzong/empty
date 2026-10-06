import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CacheRecord, HashCache } from "./scanner";

interface CacheFileShape {
  version: 1;
  root: string;
  entries: Record<string, CacheRecord>;
}

function isCacheRecord(value: unknown): value is CacheRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.size === "number" &&
    typeof record.mtimeMs === "number" &&
    typeof record.ctimeMs === "number" &&
    typeof record.ino === "number" &&
    typeof record.sha256 === "string"
  );
}

/**
 * JSON-file-backed hash cache. A record is reused by the scanner only when its
 * stored content evidence (size, mtimeMs, ctimeMs, ino) matches the file's
 * current lstat exactly; otherwise the file is re-hashed and the record is
 * replaced. A cache written for a different root is ignored.
 */
export class JsonHashCache implements HashCache {
  private readonly records = new Map<string, CacheRecord>();

  private constructor(private readonly root: string) {}

  static async load(file: string, root: string): Promise<JsonHashCache> {
    const cache = new JsonHashCache(root);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CacheFileShape>;
      if (parsed.version !== 1 || parsed.root !== root || typeof parsed.entries !== "object" || parsed.entries === null) {
        return cache;
      }
      for (const [relPath, record] of Object.entries(parsed.entries)) {
        if (isCacheRecord(record)) cache.records.set(relPath, record);
      }
    } catch {
      // Corrupt cache file: start empty rather than fail the scan.
    }
    return cache;
  }

  get(relPath: string): CacheRecord | undefined {
    return this.records.get(relPath);
  }

  set(relPath: string, record: CacheRecord): void {
    this.records.set(relPath, record);
  }

  async save(file: string): Promise<void> {
    const data: CacheFileShape = {
      version: 1,
      root: this.root,
      entries: Object.fromEntries(this.records),
    };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + "\n");
  }
}

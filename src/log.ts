import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonlSync, readJsonlSync, writeFileAtomicSync, writeJsonAtomicSync } from "./persist.js";

export interface LogEntry<V = unknown> {
  lsn: number;
  value: V;
}

interface LogMeta {
  /** First LSN still present; entries below this were reclaimed by compaction. */
  startLsn: number;
  /** Last appended LSN; 0 when the log is empty. */
  lastLsn: number;
}

/**
 * Append-only persistent log with prefix truncation.
 * LSNs start at 1 and are never reused. `truncatePrefix` physically reclaims
 * the confirmed prefix; once reclaimed, history is gone for good.
 */
export class PersistentLog<V = unknown> {
  private entries: LogEntry<V>[] = [];
  private meta: LogMeta = { startLsn: 1, lastLsn: 0 };

  private constructor(private readonly dir: string) {}

  static open<V = unknown>(dir: string): PersistentLog<V> {
    fs.mkdirSync(dir, { recursive: true });
    const log = new PersistentLog<V>(dir);
    const metaPath = path.join(dir, "meta.json");
    if (fs.existsSync(metaPath)) {
      log.meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as LogMeta;
    }
    log.entries = readJsonlSync<LogEntry<V>>(path.join(dir, "log.jsonl"));
    return log;
  }

  get startLsn(): number {
    return this.meta.startLsn;
  }

  get lastLsn(): number {
    return this.meta.lastLsn;
  }

  get length(): number {
    return this.entries.length;
  }

  append(value: V): LogEntry<V> {
    const entry: LogEntry<V> = { lsn: this.meta.lastLsn + 1, value };
    this.entries.push(entry);
    this.meta.lastLsn = entry.lsn;
    appendJsonlSync(path.join(this.dir, "log.jsonl"), entry);
    this.writeMeta();
    return entry;
  }

  /** All retained entries with lsn > `lsn`, in order. */
  entriesAfter(lsn: number): LogEntry<V>[] {
    const idx = this.entries.findIndex((e) => e.lsn > lsn);
    return idx === -1 ? [] : this.entries.slice(idx);
  }

  /**
   * Reclaim every entry with lsn <= upToLsn. Returns the number of entries
   * removed. No-op when upToLsn is below the current start; clamps at lastLsn.
   */
  truncatePrefix(upToLsn: number): number {
    const cut = Math.min(upToLsn, this.meta.lastLsn);
    if (cut < this.meta.startLsn) return 0;
    const remaining = this.entries.filter((e) => e.lsn > cut);
    const removed = this.entries.length - remaining.length;
    this.entries = remaining;
    this.meta.startLsn = cut + 1;
    const body = this.entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileAtomicSync(path.join(this.dir, "log.jsonl"), body.length > 0 ? body + "\n" : "");
    this.writeMeta();
    return removed;
  }

  private writeMeta(): void {
    writeJsonAtomicSync(path.join(this.dir, "meta.json"), this.meta);
  }
}

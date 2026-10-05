import { existsSync, mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";

/**
 * Append-only write-ahead log. Every record is JSON-serialized, appended and
 * fsynced before append() returns, so a record that was acknowledged is
 * guaranteed durable. Recovery is a plain sequential scan.
 */
export class Wal<T> {
  private readonly file: string;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, name);
  }

  get path(): string {
    return this.file;
  }

  append(record: T): void {
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, JSON.stringify(record) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readAll(): T[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  }
}

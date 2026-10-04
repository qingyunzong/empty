import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface WalRecord {
  seq: number;
  type: string;
  txnId: string;
  [key: string]: unknown;
}

/**
 * Append-only JSON-lines write-ahead log. Every append is fsync'd before
 * the call returns, so a record that was acknowledged survives a crash.
 */
export class Wal {
  private nextSeq: number;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.nextSeq = this.readAll().reduce((max, r) => Math.max(max, r.seq + 1), 0);
  }

  append(record: Omit<WalRecord, "seq">): WalRecord {
    const full = { ...record, seq: this.nextSeq++ } as WalRecord;
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, JSON.stringify(full) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return full;
  }

  readAll(): WalRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as WalRecord);
  }
}

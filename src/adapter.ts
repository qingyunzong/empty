import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Device } from "./device.js";
import { RealDevice } from "./device.js";
import type { Snapshot } from "./types.js";
import { emptySnapshot } from "./types.js";

/**
 * Storage adapter contract. commitBatch must persist records, cursor and
 * appliedCursors atomically: after any crash, load() returns either the
 * full previous state or the full new state, never a mixture.
 */
export interface StorageAdapter {
  load(): Snapshot;
  commitBatch(snapshot: Snapshot): void;
}

const STATE_FILE = "state.json";
const TMP_FILE = "state.json.tmp";

/**
 * File-backed adapter. Atomicity comes from the classic
 * write-tmp -> fsync -> atomic rename -> fsync-dir protocol: the rename is
 * the single commit point, so a crash anywhere leaves either the old or the
 * new state on disk. A leftover tmp file from a torn write is ignored on
 * load because only the renamed file is ever read.
 */
export class FileStorageAdapter implements StorageAdapter {
  private readonly statePath: string;
  private readonly tmpPath: string;

  constructor(
    private readonly dir: string,
    private readonly device: Device = new RealDevice(),
  ) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, STATE_FILE);
    this.tmpPath = join(dir, TMP_FILE);
  }

  load(): Snapshot {
    const raw = this.device.readFile(this.statePath);
    if (raw === null) return emptySnapshot();
    return JSON.parse(raw) as Snapshot;
  }

  commitBatch(snapshot: Snapshot): void {
    const data = JSON.stringify(snapshot);
    this.device.writeTmp(this.tmpPath, data); // write boundary 1
    this.device.fsyncFile(this.tmpPath); // write boundary 2
    this.device.rename(this.tmpPath, this.statePath); // write boundary 3 (commit point)
    this.device.fsyncDir(this.dir); // write boundary 4
  }
}

/** Volatile adapter used as the crash-free reference implementation. */
export class InMemoryAdapter implements StorageAdapter {
  private snapshot: Snapshot = emptySnapshot();

  load(): Snapshot {
    return {
      records: { ...this.snapshot.records },
      cursor: this.snapshot.cursor,
      appliedCursors: [...this.snapshot.appliedCursors],
    };
  }

  commitBatch(snapshot: Snapshot): void {
    this.snapshot = {
      records: { ...snapshot.records },
      cursor: snapshot.cursor,
      appliedCursors: [...snapshot.appliedCursors],
    };
  }
}

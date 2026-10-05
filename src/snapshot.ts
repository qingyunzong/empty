import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomicSync } from "./persist.js";

/** Opaque handle to a stored snapshot; required to join as a new replica. */
export interface Snapshot {
  lsn: number;
}

/**
 * Versioned snapshot store. Snapshots are immutable, addressed by the LSN
 * they capture, and persisted as `snapshot-<lsn>.json` plus an index.
 */
export class SnapshotStore<S> {
  private readonly states = new Map<number, S>();

  private constructor(private readonly dir: string) {}

  static open<S>(dir: string): SnapshotStore<S> {
    fs.mkdirSync(dir, { recursive: true });
    const store = new SnapshotStore<S>(dir);
    const indexPath = path.join(dir, "index.json");
    if (fs.existsSync(indexPath)) {
      const lsns = JSON.parse(fs.readFileSync(indexPath, "utf8")) as number[];
      for (const lsn of lsns) {
        const file = path.join(dir, `snapshot-${lsn}.json`);
        store.states.set(lsn, JSON.parse(fs.readFileSync(file, "utf8")) as S);
      }
    }
    return store;
  }

  save(lsn: number, state: S): Snapshot {
    this.states.set(lsn, structuredClone(state));
    writeJsonAtomicSync(path.join(this.dir, `snapshot-${lsn}.json`), this.states.get(lsn));
    const index = [...this.states.keys()].sort((a, b) => a - b);
    writeJsonAtomicSync(path.join(this.dir, "index.json"), index);
    return { lsn };
  }

  has(lsn: number): boolean {
    return this.states.has(lsn);
  }

  /** Defensive copy of the snapshot state at `lsn`. */
  get(lsn: number): S | undefined {
    const state = this.states.get(lsn);
    return state === undefined ? undefined : structuredClone(state);
  }

  latest(): Snapshot | undefined {
    return this.latestAtOrBefore(Number.MAX_SAFE_INTEGER);
  }

  latestAtOrBefore(lsn: number): Snapshot | undefined {
    let best: number | undefined;
    for (const key of this.states.keys()) {
      if (key <= lsn && (best === undefined || key > best)) best = key;
    }
    return best === undefined ? undefined : { lsn: best };
  }
}

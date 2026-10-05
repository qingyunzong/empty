import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { EngineSnapshot } from "./engine.js";

/**
 * Persistent index for engine snapshots.
 *
 * Writes are atomic: the snapshot is serialized to a temporary file and then
 * renamed over the target. A crash mid-write can leave a stale `.tmp` file
 * behind, but the last fully committed snapshot stays intact and is what
 * recovery reads back.
 */
export function saveSnapshot(path: string, snapshot: EngineSnapshot): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, path);
}

/** Recovers the last committed snapshot, or null if none exists. */
export function loadSnapshot(path: string): EngineSnapshot | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as EngineSnapshot;
}

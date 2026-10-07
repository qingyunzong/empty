import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { ConflictRecord } from "./cache.js";
import type { MusFrontier } from "./mus.js";

export interface NamedSource {
  id: string;
  expr: string;
}

export interface StateFile {
  version: 1;
  constraints: NamedSource[];
  assumptions: NamedSource[];
  cache: ConflictRecord[];
  /** Persisted solver frontier of a paused search, if any. */
  frontier: MusFrontier | null;
}

export function emptyState(): StateFile {
  return { version: 1, constraints: [], assumptions: [], cache: [], frontier: null };
}

export function loadState(path: string): StateFile {
  if (!existsSync(path)) return emptyState();
  const raw = JSON.parse(readFileSync(path, "utf8")) as StateFile;
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.constraints) ||
    !Array.isArray(raw.assumptions) ||
    !Array.isArray(raw.cache)
  ) {
    throw new Error(`${path} is not a bool-mus state file (or uses an unsupported version)`);
  }
  return raw;
}

export function saveState(path: string, state: StateFile): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

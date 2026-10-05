import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ConflictCacheEntry, Frontier } from "./solver.js";
import type { ProofNode } from "./proof.js";

// JSON state file shared by all CLI commands: named assumptions, the minimal
// conflict cache, a paused frontier (if any), and the last solve result.

export interface StoredResult {
  status: "sat" | "unsat";
  inputHash: string;
  constraints: Record<string, string>;
  assignment?: Record<string, boolean>;
  assignmentIndex?: number;
  core?: string[];
  proof?: ProofNode;
  proofTree?: string;
  stats: {
    totalSteps: number;
    smallerSubsetsChecked: number;
    cacheHit: string[] | null;
  };
}

export interface PendingRun {
  inputHash: string;
  constraints: Record<string, string>;
  frontier: Frontier;
}

export interface StateFile {
  version: 1;
  assumptions: Record<string, string>;
  cache: ConflictCacheEntry[];
  pending?: PendingRun;
  result?: StoredResult;
}

export function emptyState(): StateFile {
  return { version: 1, assumptions: {}, cache: [] };
}

export function loadState(path: string): StateFile {
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as StateFile;
  return {
    version: 1,
    assumptions: parsed.assumptions ?? {},
    cache: parsed.cache ?? [],
    pending: parsed.pending,
    result: parsed.result,
  };
}

export function saveState(path: string, state: StateFile): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function hashConstraints(constraints: Record<string, string>): string {
  const canonical = Object.keys(constraints)
    .sort()
    .map((k) => [k, constraints[k]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// Cache entries are never deleted when an assumption is retracted; instead
// the solver only reuses an entry when every source still exists. This helper
// performs the same check for display and testing purposes.
export function cacheEntryReusable(entry: ConflictCacheEntry, available: Set<string>): boolean {
  return entry.sources.every((s) => available.has(s));
}

export function addToCache(cache: ConflictCacheEntry[], sources: string[]): ConflictCacheEntry[] {
  const key = sources.slice().sort().join(" ");
  if (cache.some((e) => e.sources.slice().sort().join(" ") === key)) return cache;
  return [...cache, { sources: sources.slice().sort() }];
}

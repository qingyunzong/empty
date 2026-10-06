import type { ValueHash } from "./merkle.js";

export interface MapDiff {
  readonly pull: string[];
  readonly remove: string[];
}

/**
 * Reference implementation: diff two full key -> valueHash maps directly.
 * Used to verify that a Merkle-tree pull plan is exactly the minimal
 * necessary set of changes.
 */
export function fullMapDiff(
  local: ReadonlyMap<string, ValueHash>,
  remote: ReadonlyMap<string, ValueHash>,
): MapDiff {
  const pull: string[] = [];
  const remove: string[] = [];
  for (const [key, valueHash] of remote) {
    if (local.get(key) !== valueHash) pull.push(key);
  }
  for (const key of local.keys()) {
    if (!remote.has(key)) remove.push(key);
  }
  pull.sort();
  remove.sort();
  return { pull, remove };
}

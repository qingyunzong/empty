import { LogEvent } from "./types.js";

/**
 * Dependency graph over a set of events.
 * Edge u -> v (in `dependents`) means: v depends on u, so u must be ordered
 * before v. Dependencies referencing unknown events are tracked separately
 * in the missing-dependency index.
 */
export interface Graph {
  events: Map<string, LogEvent>;
  /** event id -> its dependency ids that exist in the graph (sorted). */
  presentDeps: Map<string, string[]>;
  /** event id -> ids of events that depend on it (sorted). */
  dependents: Map<string, string[]>;
  /** event id -> its dependency ids that are missing from the graph (sorted). */
  directMissing: Map<string, string[]>;
  /** missing dependency id -> ids of events directly depending on it (sorted). */
  missingIndex: Map<string, string[]>;
}

export function buildGraph(events: Iterable<LogEvent>): Graph {
  const map = new Map<string, LogEvent>();
  for (const e of events) {
    if (map.has(e.id)) throw new Error(`duplicate event id: ${e.id}`);
    map.set(e.id, e);
  }
  const presentDeps = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const directMissing = new Map<string, string[]>();
  const missingIndex = new Map<string, string[]>();
  for (const id of map.keys()) {
    presentDeps.set(id, []);
    dependents.set(id, []);
    directMissing.set(id, []);
  }
  for (const [id, e] of map) {
    for (const d of e.deps) {
      if (map.has(d)) {
        presentDeps.get(id)!.push(d);
        dependents.get(d)!.push(id);
      } else {
        directMissing.get(id)!.push(d);
        const arr = missingIndex.get(d) ?? [];
        arr.push(id);
        missingIndex.set(d, arr);
      }
    }
  }
  for (const arr of presentDeps.values()) arr.sort();
  for (const arr of dependents.values()) arr.sort();
  for (const arr of directMissing.values()) arr.sort();
  for (const arr of missingIndex.values()) arr.sort();
  return { events: map, presentDeps, dependents, directMissing, missingIndex };
}

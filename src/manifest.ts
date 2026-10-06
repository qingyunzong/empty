import { Manifest, ManifestEntry } from "./types";

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeEntry(entry: ManifestEntry): ManifestEntry {
  const out: ManifestEntry = { path: entry.path, type: entry.type };
  if (entry.size !== undefined) out.size = entry.size;
  if (entry.sha256 !== undefined) out.sha256 = entry.sha256;
  if (entry.target !== undefined) out.target = entry.target;
  if (entry.unstable) out.unstable = true;
  return out;
}

/**
 * Deterministic serialization: entries sorted by path, fixed key order.
 * Two manifests over identical trees produce byte-identical output.
 */
export function canonicalize(manifest: Manifest): string {
  const entries = [...manifest.entries].sort((a, b) => comparePaths(a.path, b.path)).map(normalizeEntry);
  return JSON.stringify({ version: manifest.version, entries }, null, 2) + "\n";
}

export interface EntryChange {
  path: string;
  fields: string[];
  before: ManifestEntry;
  after: ManifestEntry;
}

export interface ManifestDiff {
  equal: boolean;
  added: ManifestEntry[];
  removed: ManifestEntry[];
  changed: EntryChange[];
}

const COMPARED_FIELDS: ReadonlyArray<"type" | "size" | "sha256" | "target" | "unstable"> = [
  "type",
  "size",
  "sha256",
  "target",
  "unstable",
];

function fieldValue(entry: ManifestEntry, field: (typeof COMPARED_FIELDS)[number]): unknown {
  return field === "unstable" ? Boolean(entry.unstable) : entry[field];
}

export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const beforeMap = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.entries.map((entry) => [entry.path, entry]));
  const added: ManifestEntry[] = [];
  const removed: ManifestEntry[] = [];
  const changed: EntryChange[] = [];

  for (const [path, afterEntry] of afterMap) {
    const beforeEntry = beforeMap.get(path);
    if (!beforeEntry) {
      added.push(afterEntry);
      continue;
    }
    const fields = COMPARED_FIELDS.filter((field) => fieldValue(beforeEntry, field) !== fieldValue(afterEntry, field));
    if (fields.length > 0) changed.push({ path, fields, before: beforeEntry, after: afterEntry });
  }
  for (const [path, beforeEntry] of beforeMap) {
    if (!afterMap.has(path)) removed.push(beforeEntry);
  }

  added.sort((a, b) => comparePaths(a.path, b.path));
  removed.sort((a, b) => comparePaths(a.path, b.path));
  changed.sort((a, b) => comparePaths(a.path, b.path));
  return { equal: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed };
}

export function formatDiff(diff: ManifestDiff): string {
  if (diff.equal) return "manifests are identical\n";
  const lines: string[] = [];
  for (const entry of diff.added) lines.push(`+ ${entry.path} (${entry.type})`);
  for (const entry of diff.removed) lines.push(`- ${entry.path} (${entry.type})`);
  for (const change of diff.changed) lines.push(`~ ${change.path} [${change.fields.join(", ")}]`);
  return lines.join("\n") + "\n";
}

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Compute a deterministic content hash over a set of named files.
 * The hash binds BOTH the file paths and the exact file contents:
 * any change to any file (or the file set) yields a different hash.
 */
export function hashSourceFiles(files: ReadonlyMap<string, string> | Record<string, string>): string {
  const entries: Array<[string, string]> =
    files instanceof Map ? [...files.entries()] : Object.entries(files);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const [path, content] of entries) {
    h.update(path, "utf8");
    h.update("\0");
    h.update(content, "utf8");
    h.update("\0");
  }
  return h.digest("hex");
}

/** Recursively list files under dir (relative posix-style paths, sorted). */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  out.sort();
  return out;
}

/** Read a directory tree into a path->content map. */
export function readSourceTree(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of listFilesRecursive(dir)) {
    map.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return map;
}

/** Hash the current on-disk source tree. */
export function hashSourceTree(dir: string): string {
  return hashSourceFiles(readSourceTree(dir));
}

/**
 * Verify that the on-disk tree still matches an expected hash.
 * Returns the actual hash and, on mismatch, the list of changed paths
 * (added / removed / modified) relative to the recorded snapshot, when
 * the snapshot contents are provided.
 */
export function verifySourceTree(
  dir: string,
  expectedHash: string,
  snapshot?: ReadonlyMap<string, string>,
): { ok: boolean; actualHash: string; changedPaths: string[] } {
  const current = readSourceTree(dir);
  const actualHash = hashSourceFiles(current);
  const changedPaths: string[] = [];
  if (snapshot) {
    const paths = new Set([...current.keys(), ...snapshot.keys()]);
    for (const p of [...paths].sort()) {
      if (!current.has(p) || !snapshot.has(p) || current.get(p) !== snapshot.get(p)) {
        changedPaths.push(p);
      }
    }
  }
  return { ok: actualHash === expectedHash, actualHash, changedPaths };
}

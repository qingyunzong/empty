import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Hash an ordered set of (name, content) pairs. Entries are sorted by name so
 * the digest depends only on the file set, not on enumeration order.
 */
export function hashContents(
  entries: ReadonlyArray<readonly [string, string]>
): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const [name, content] of sorted) {
    hash.update(name);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Hash a set of source files by path + content. */
export function hashFiles(paths: readonly string[]): string {
  return hashContents(
    paths.map((p) => [p, readFileSync(p, "utf8")] as const)
  );
}

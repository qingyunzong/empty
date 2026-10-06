/**
 * Archive directory index for the browser importer.
 *
 * Semantics:
 * - Paths are segmented by '/'. Empty segments and '.' are dropped; '..' pops
 *   the previous segment. Dot-segment elimination that would climb above the
 *   archive root is rejected with PathEscapeError.
 * - Matching is case-sensitive: no case folding is ever applied.
 * - Two entries that normalize to the same path reject the whole archive
 *   (DuplicatePathError); no partial index is produced.
 * - Symlink targets are normalized (relative targets resolve against the
 *   link's parent directory, targets starting with '/' against the archive
 *   root) and expanded through the index. A resolution cycle returns the
 *   shortest repeated chain of link paths.
 */

export type EntryType = 'file' | 'directory' | 'symlink';

export interface ArchiveEntry {
  readonly path: string;
  readonly type: EntryType;
  /** Link target; required when `type` is 'symlink'. */
  readonly target?: string;
}

export interface IndexedEntry {
  readonly type: EntryType;
  /** Normalized path of this entry (no leading or trailing '/'). */
  readonly path: string;
  /** Normalized, archive-root-relative link target (symlinks only). */
  readonly target?: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly cycle: readonly string[] };

export class ArchiveIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Dot-segment elimination climbed above the archive root. */
export class PathEscapeError extends ArchiveIndexError {
  readonly path: string;
  constructor(path: string) {
    super(`path escapes archive root: ${JSON.stringify(path)}`);
    this.path = path;
  }
}

/** Two entries normalized to the same path; the whole archive is rejected. */
export class DuplicatePathError extends ArchiveIndexError {
  readonly normalizedPath: string;
  constructor(normalizedPath: string) {
    super(`duplicate normalized path: ${JSON.stringify(normalizedPath)}`);
    this.normalizedPath = normalizedPath;
  }
}

/** An entry is malformed (e.g. a symlink without a target). */
export class InvalidEntryError extends ArchiveIndexError {}

/**
 * Normalize a slash-segmented path: drop empty and '.' segments, resolve '..'
 * against the accumulated segments. Throws PathEscapeError if '..' would go
 * above the root. Case-sensitive; never folds case.
 */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) throw new PathEscapeError(path);
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

function parentOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('/');
  return slash === -1 ? '' : normalizedPath.slice(0, slash);
}

/**
 * Normalize a symlink target. Targets starting with '/' are relative to the
 * archive root; all others are relative to the directory containing the link.
 * `linkPath` must already be normalized.
 */
export function normalizeSymlinkTarget(linkPath: string, target: string): string {
  if (target.startsWith('/')) return normalizePath(target);
  const parent = parentOf(linkPath);
  return normalizePath(parent === '' ? target : `${parent}/${target}`);
}

export interface ArchiveIndex {
  readonly size: number;
  /** Lookup by path; the path is normalized first. */
  has(path: string): boolean;
  /** Lookup by path; the path is normalized first. */
  get(path: string): IndexedEntry | undefined;
  entries(): IterableIterator<IndexedEntry>;
  /**
   * Resolve a path, expanding symlinks through the index. Returns the final
   * normalized path, or the shortest repeated chain of link paths when the
   * expansion cycles.
   */
  resolve(path: string): ResolveResult;
}

class Index implements ArchiveIndex {
  constructor(private readonly byPath: Map<string, IndexedEntry>) {}

  get size(): number {
    return this.byPath.size;
  }

  has(path: string): boolean {
    return this.byPath.has(normalizePath(path));
  }

  get(path: string): IndexedEntry | undefined {
    return this.byPath.get(normalizePath(path));
  }

  *entries(): IterableIterator<IndexedEntry> {
    yield* this.byPath.values();
  }

  resolve(path: string): ResolveResult {
    let current = normalizePath(path);
    const chain: string[] = [];
    const seenAt = new Map<string, number>();
    for (;;) {
      const entry = this.byPath.get(current);
      if (entry === undefined || entry.type !== 'symlink') {
        return { ok: true, path: current };
      }
      const at = seenAt.get(current);
      if (at !== undefined) {
        return { ok: false, cycle: chain.slice(at) };
      }
      seenAt.set(current, chain.length);
      chain.push(current);
      current = entry.target as string;
    }
  }
}

/**
 * Build an index over archive entries. Any PathEscapeError or
 * DuplicatePathError rejects the whole archive: the function throws and no
 * partial index is produced.
 */
export function buildIndex(entries: Iterable<ArchiveEntry>): ArchiveIndex {
  const byPath = new Map<string, IndexedEntry>();
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (byPath.has(path)) throw new DuplicatePathError(path);
    if (entry.type === 'symlink') {
      if (entry.target === undefined) {
        throw new InvalidEntryError(`symlink without target: ${JSON.stringify(entry.path)}`);
      }
      byPath.set(path, {
        type: 'symlink',
        path,
        target: normalizeSymlinkTarget(path, entry.target),
      });
    } else {
      byPath.set(path, { type: entry.type, path });
    }
  }
  return new Index(byPath);
}

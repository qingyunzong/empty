import { ArchiveError } from './errors.js';
import { joinNormalized, normalizePath, parentOf, splitNormalized } from './normalize.js';

export type EntryType = 'file' | 'dir' | 'symlink';

export interface ArchiveEntry {
  path: string;
  type: EntryType;
  /** Required for symlink entries: slash-segmented, relative to the symlink's parent dir or absolute from root. */
  target?: string;
}

export interface ResolvedEntry {
  /** Final normalized path after symlink expansion. */
  path: string;
  type: EntryType;
  /** The originating entry, or null for the root / implicit directories. */
  entry: ArchiveEntry | null;
}

interface Node {
  type: EntryType;
  entry: ArchiveEntry | null;
  targetSegments?: string[];
}

export class ArchiveIndex {
  private readonly nodes = new Map<string, Node>();

  constructor() {
    this.nodes.set('', { type: 'dir', entry: null });
  }

  /** Number of explicit entries. */
  get size(): number {
    let count = 0;
    for (const node of this.nodes.values()) if (node.entry !== null) count++;
    return count;
  }

  /** Normalized paths of all explicit entries, in insertion order. */
  keys(): string[] {
    const out: string[] = [];
    for (const [path, node] of this.nodes) if (node.entry !== null) out.push(path);
    return out;
  }

  add(entry: ArchiveEntry): void {
    const normalized = normalizePath(entry.path);
    if (normalized === '') {
      throw new ArchiveError('EMPTY_PATH', `entry path normalizes to the archive root: ${JSON.stringify(entry.path)}`);
    }
    const existing = this.nodes.get(normalized);
    if (existing !== undefined) {
      if (existing.entry !== null) {
        throw new ArchiveError('DUPLICATE_PATH', `duplicate normalized path: ${JSON.stringify(normalized)}`);
      }
      // Existing node is an implicit directory created for a descendant entry.
      if (entry.type !== 'dir') {
        throw new ArchiveError(
          'TYPE_CONFLICT',
          `non-directory entry ${JSON.stringify(normalized)} already has children`,
        );
      }
    }
    // Every ancestor must be a directory (explicit or implicit).
    let prefix = '';
    const segments = splitNormalized(normalized);
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      const parent = this.nodes.get(prefix);
      if (parent !== undefined) {
        if (parent.type !== 'dir') {
          throw new ArchiveError(
            'TYPE_CONFLICT',
            `entry ${JSON.stringify(normalized)} sits under non-directory ${JSON.stringify(prefix)}`,
          );
        }
      } else {
        this.nodes.set(prefix, { type: 'dir', entry: null });
      }
    }
    const node: Node = { type: entry.type, entry };
    if (entry.type === 'symlink') {
      if (entry.target === undefined) {
        throw new ArchiveError('MISSING_TARGET', `symlink ${JSON.stringify(normalized)} has no target`);
      }
      // The target is normalized once, relative to the symlink's parent directory.
      node.targetSegments = splitNormalized(joinNormalized(parentOf(normalized), entry.target));
    }
    this.nodes.set(normalized, node);
  }

  /** Raw lookup by normalized path, without symlink expansion. */
  get(path: string): ResolvedEntry | undefined {
    const node = this.nodes.get(normalizePath(path));
    if (node === undefined) return undefined;
    return { path: normalizePath(path), type: node.type, entry: node.entry };
  }

  /**
   * Resolve a path, expanding symlinks by their normalized targets.
   * Throws SYMLINK_CYCLE with the shortest repeated chain when expansion loops.
   */
  resolve(path: string): ResolvedEntry {
    let segments = splitNormalized(normalizePath(path));
    const chain: string[] = [];
    for (;;) {
      const hit = this.firstSymlinkOn(segments);
      if (hit === null) break;
      const repeatedAt = chain.indexOf(hit.path);
      if (repeatedAt >= 0) {
        const cycle = chain.slice(repeatedAt);
        throw new ArchiveError(
          'SYMLINK_CYCLE',
          `symlink cycle: ${[...cycle, hit.path].join(' -> ')}`,
          cycle,
        );
      }
      chain.push(hit.path);
      segments = [...hit.targetSegments, ...segments.slice(hit.length)];
    }
    const finalPath = segments.join('/');
    const node = this.nodes.get(finalPath);
    if (node === undefined) {
      throw new ArchiveError('NOT_FOUND', `no entry at ${JSON.stringify(finalPath)}`);
    }
    return { path: finalPath, type: node.type, entry: node.entry };
  }

  private firstSymlinkOn(
    segments: string[],
  ): { path: string; length: number; targetSegments: string[] } | null {
    let prefix = '';
    let index = 0;
    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      index++;
      const node = this.nodes.get(prefix);
      if (node !== undefined && node.type === 'symlink' && node.targetSegments !== undefined) {
        return { path: prefix, length: index, targetSegments: node.targetSegments };
      }
    }
    return null;
  }
}

/**
 * Build an index from archive entries. Any invalid entry (root-escaping path,
 * duplicate normalized path, type conflict, bad symlink) rejects the whole package.
 */
export function buildIndex(entries: ArchiveEntry[]): ArchiveIndex {
  const index = new ArchiveIndex();
  for (const entry of entries) index.add(entry);
  return index;
}

export { ArchiveError, isArchiveError } from './errors.js';
export type { ArchiveErrorCode } from './errors.js';
export { normalizePath } from './normalize.js';

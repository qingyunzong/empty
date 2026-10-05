import {
  NotDirectoryError,
  NotFoundError,
  SandboxEscapeError,
  SymlinkLoopError,
  TooManyExpansionsError,
} from './errors.js';
import { DirNode, VfsNode, VirtualFileTree } from './vfs.js';

export const DEFAULT_MAX_EXPANSIONS = 40;

/** Snapshot of one traversed directory: identity plus its generation. */
export interface ChainEntry {
  readonly dirId: number;
  readonly generation: number;
}

export interface Resolution {
  readonly node: VfsNode;
  /** Directories traversed from the sandbox root to the result, with generations. */
  readonly chain: readonly ChainEntry[];
  /** How many symlink expansions this resolution performed. */
  readonly expansions: number;
}

export interface ResolveOptions {
  readonly maxExpansions?: number;
  /**
   * Invoked synchronously each time resolution enters a directory, before any
   * of that directory's entries are inspected. Throw to abort the walk.
   */
  readonly onEnterDir?: (dir: DirNode) => void;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((c) => c.length > 0 && c !== '.');
}

function chainEntry(dir: DirNode): ChainEntry {
  return { dirId: dir.id, generation: dir.generation };
}

/**
 * Resolves relative paths and symlinks one component at a time, verifying the
 * sandbox boundary after every expansion step. Link loops and expansion-count
 * overflows are reported as errors.
 */
export class SandboxResolver {
  constructor(
    readonly tree: VirtualFileTree,
    readonly sandboxRoot: DirNode,
    readonly maxExpansions: number = DEFAULT_MAX_EXPANSIONS,
  ) {}

  resolve(path: string, options: ResolveOptions = {}): Resolution {
    const max = options.maxExpansions ?? this.maxExpansions;
    const onEnterDir = options.onEnterDir ?? (() => {});
    const visitedLinks = new Set<number>();
    let expansions = 0;

    let current: DirNode = this.sandboxRoot;
    onEnterDir(current);
    let chain: ChainEntry[] = [chainEntry(current)];
    let components = splitPath(path);
    let index = 0;

    while (index < components.length) {
      const comp = components[index]!;

      if (comp === '..') {
        if (current === this.sandboxRoot) {
          throw new SandboxEscapeError(path);
        }
        current = current.parent!;
        onEnterDir(current);
        chain.push(chainEntry(current));
        index++;
        continue;
      }

      const child = current.children.get(comp);
      if (!child) throw new NotFoundError(path);

      if (child.kind === 'dir') {
        current = child;
        onEnterDir(current);
        chain.push(chainEntry(current));
        index++;
        continue;
      }

      if (child.kind === 'file') {
        if (index !== components.length - 1) throw new NotDirectoryError(path);
        this.assertWithinSandbox(current, path);
        return { node: child, chain, expansions };
      }

      // Symlink: expand one step, then re-verify the boundary.
      expansions++;
      if (expansions > max) throw new TooManyExpansionsError(path, max);
      if (visitedLinks.has(child.id)) throw new SymlinkLoopError(path);
      visitedLinks.add(child.id);

      const rest = components.slice(index + 1);
      if (child.target.startsWith('/')) {
        current = this.tree.root;
        onEnterDir(current);
        chain = [chainEntry(current)];
      }
      components = [...splitPath(child.target), ...rest];
      index = 0;
      this.assertWithinSandbox(current, path);
    }

    this.assertWithinSandbox(current, path);
    return { node: current, chain, expansions };
  }

  /** Boundary check: the position must be the sandbox root or a descendant. */
  private assertWithinSandbox(dir: DirNode, path: string): void {
    for (let cursor: DirNode | null = dir; cursor !== null; cursor = cursor.parent) {
      if (cursor === this.sandboxRoot) return;
    }
    throw new SandboxEscapeError(path);
  }
}

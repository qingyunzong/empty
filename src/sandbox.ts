import { IsDirectoryError, StaleGenerationError } from './errors.js';
import { ChainEntry, DEFAULT_MAX_EXPANSIONS, Resolution, SandboxResolver } from './resolver.js';
import { DirNode, FileNode, VirtualFileTree } from './vfs.js';

/**
 * Proof that an existence check observed a particular directory generation.
 * Obtained from `stat`/`exists`, redeemed at `open`.
 */
export class AccessTicket {
  constructor(
    readonly path: string,
    readonly chain: readonly ChainEntry[],
  ) {}
}

export interface StatResult {
  readonly kind: 'dir' | 'file' | 'symlink';
  readonly ticket: AccessTicket;
}

function chainsEqual(a: readonly ChainEntry[], b: readonly ChainEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.dirId === b[i]!.dirId && entry.generation === b[i]!.generation);
}

/**
 * Sandboxed file-access facade. `stat`/`exists` capture the directory
 * generation chain of the resolution; `open` re-resolves and refuses to
 * follow the path if any traversed directory changed in between — so a
 * swapped symlink can never redirect an open to an outside object.
 */
export class SandboxFS {
  private readonly resolver: SandboxResolver;

  constructor(tree: VirtualFileTree, sandboxRoot: DirNode, maxExpansions: number = DEFAULT_MAX_EXPANSIONS) {
    this.resolver = new SandboxResolver(tree, sandboxRoot, maxExpansions);
  }

  private ticketFor(path: string, resolution: Resolution): AccessTicket {
    return new AccessTicket(path, resolution.chain);
  }

  stat(path: string): StatResult {
    const resolution = this.resolver.resolve(path);
    return { kind: resolution.node.kind, ticket: this.ticketFor(path, resolution) };
  }

  exists(path: string): { exists: true; ticket: AccessTicket } | { exists: false } {
    try {
      const resolution = this.resolver.resolve(path);
      return { exists: true, ticket: this.ticketFor(path, resolution) };
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return { exists: false };
      }
      throw err;
    }
  }

  /**
   * Opens a file for reading. When `ticket` is supplied, the resolution must
   * reproduce the exact directory-generation chain captured at check time;
   * otherwise a StaleGenerationError is thrown and nothing is opened.
   */
  open(path: string, ticket?: AccessTicket): string {
    let resolution;
    if (ticket) {
      if (ticket.path !== path) throw new StaleGenerationError(path);
      // Re-resolve with a generation guard: entering any directory whose
      // generation changed since the check aborts the walk immediately,
      // before a swapped symlink's target is ever followed.
      const expected = new Map(ticket.chain.map((e) => [e.dirId, e.generation]));
      resolution = this.resolver.resolve(path, {
        onEnterDir: (dir) => {
          const generation = expected.get(dir.id);
          if (generation !== undefined && generation !== dir.generation) {
            throw new StaleGenerationError(path);
          }
        },
      });
      if (!chainsEqual(ticket.chain, resolution.chain)) {
        throw new StaleGenerationError(path);
      }
    } else {
      resolution = this.resolver.resolve(path);
    }
    const node = resolution.node;
    if (node.kind !== 'file') throw new IsDirectoryError(path);
    const file = node as FileNode;
    file.openCount++;
    return file.content;
  }
}

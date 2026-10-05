import { FsError } from "./errors.js";
import { displayPath, isPrefixOf, normalizeSegments, splitPath } from "./pathutil.js";
import type { DirNode, FileNode, SymlinkNode, VNode } from "./vfs.js";
import { Vfs } from "./vfs.js";

/** Generation of one directory observed during a resolution walk. */
export interface DirGeneration {
  /** Vfs-absolute path of the directory, e.g. "/sandbox/sub". */
  path: string;
  generation: number;
}

/**
 * Result of a successful `exists()` check. Binds the checked path to the
 * generation of every directory traversed while resolving it, so a later
 * `open()` can prove the directory chain did not change in between.
 */
export interface LookupTicket {
  readonly input: string;
  /** Vfs-absolute path the input resolved to. */
  readonly resolved: string;
  readonly kind: VNode["kind"];
  readonly generations: readonly DirGeneration[];
}

export interface Resolution {
  node: VNode;
  /** Vfs-absolute component stack of the resolved node. */
  stack: string[];
  generations: DirGeneration[];
}

export interface SandboxOptions {
  /** Maximum symlink expansions per resolution (Linux uses 40). */
  maxExpansions?: number;
}

const DEFAULT_MAX_EXPANSIONS = 40;

/**
 * A chroot-like view over a subtree of a {@link Vfs}.
 *
 * Resolution walks one path component at a time. Every symlink expansion
 * normalizes the link target and verifies the result still lies inside the
 * sandbox root *before* the walk continues, so an escaping link is rejected
 * at the exact step that would cross the boundary. Cycles (ELOOP) and
 * expansion-count overflows (EMLINK) are detected separately.
 */
export class Sandbox {
  private readonly rootStack: string[];
  private readonly maxExpansions: number;

  constructor(
    private readonly vfs: Vfs,
    readonly rootPath: string,
    options: SandboxOptions = {},
  ) {
    this.rootStack = normalizeSegments([], splitPath(rootPath));
    const rootNode = this.nodeAt(this.rootStack);
    if (rootNode === undefined || rootNode.kind !== "dir") {
      throw new FsError("ENOENT", `sandbox root is not a directory: ${rootPath}`);
    }
    this.maxExpansions = options.maxExpansions ?? DEFAULT_MAX_EXPANSIONS;
  }

  /**
   * Resolve `path` (absolute = sandbox-absolute, relative = relative to the
   * sandbox root) to a vnode, expanding symlinks along the way.
   */
  resolve(path: string, followFinalSymlink = true): Resolution {
    let stack: string[] = [...this.rootStack];
    let queue = splitPath(path);
    const visited = new Set<SymlinkNode>();
    let expansions = 0;
    const generations: DirGeneration[] = [];

    const recordGeneration = (node: VNode, dirStack: readonly string[]): void => {
      if (node.kind !== "dir") return;
      const pathKey = displayPath(dirStack);
      const last = generations[generations.length - 1];
      if (last === undefined || last.path !== pathKey) {
        generations.push({ path: pathKey, generation: node.generation });
      }
    };

    let node: VNode = this.nodeAt(stack) as DirNode;
    recordGeneration(node, stack);

    let i = 0;
    while (i < queue.length) {
      const comp = queue[i] as string;
      if (comp === "" || comp === ".") {
        i++;
        continue;
      }
      if (comp === "..") {
        // Chroot semantics: ".." at the sandbox root clamps, never escapes.
        if (stack.length > this.rootStack.length) stack.pop();
        node = this.nodeAt(stack) as DirNode;
        recordGeneration(node, stack);
        i++;
        continue;
      }
      if (node.kind !== "dir") {
        throw new FsError("ENOTDIR", `not a directory: ${displayPath(stack)}`);
      }
      const child = node.children.get(comp);
      if (child === undefined) {
        throw new FsError("ENOENT", `no such entry: ${displayPath([...stack, comp])}`);
      }
      const isLast = i === queue.length - 1;
      if (child.kind === "symlink" && (followFinalSymlink || !isLast)) {
        if (visited.has(child)) {
          throw new FsError("ELOOP", `symlink cycle at ${displayPath([...stack, comp])}`);
        }
        visited.add(child);
        expansions++;
        if (expansions > this.maxExpansions) {
          throw new FsError(
            "EMLINK",
            `too many symlink expansions (limit ${this.maxExpansions}) while resolving ${path}`,
          );
        }
        const targetSegments = splitPath(child.target);
        const base = child.target.startsWith("/") ? [] : [...stack];
        // Boundary check for THIS expansion step, before walking any further.
        const projected = normalizeSegments(base, targetSegments);
        if (!isPrefixOf(this.rootStack, projected)) {
          throw new FsError(
            "ESCAPE",
            `symlink ${displayPath([...stack, comp])} -> ${child.target} escapes sandbox ${this.rootPath}`,
          );
        }
        queue = [...targetSegments, ...queue.slice(i + 1)];
        stack = base;
        node = this.nodeAt(stack) as DirNode;
        i = 0;
        continue;
      }
      stack.push(comp);
      node = child;
      recordGeneration(node, stack);
      i++;
    }
    return { node, stack, generations };
  }

  /**
   * Existence check. Returns a {@link LookupTicket} binding the result to
   * the generations of every directory on the resolved path, or `null`
   * when the path does not exist. Boundary/loop errors are still thrown.
   */
  exists(path: string): LookupTicket | null {
    let res: Resolution;
    try {
      res = this.resolve(path);
    } catch (err) {
      if (err instanceof FsError && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return null;
      }
      throw err;
    }
    return {
      input: path,
      resolved: displayPath(res.stack),
      kind: res.node.kind,
      generations: res.generations,
    };
  }

  /**
   * Open a regular file. When `ticket` is given (from a prior `exists()`),
   * every directory recorded in the ticket must still exist with the same
   * generation, i.e. check and open are bound to the same directory
   * generation. The staleness check is done by literal path lookup *before*
   * any symlink is followed, so a swapped link fails with ESTALE instead
   * of ever being traversed.
   */
  open(path: string, ticket?: LookupTicket): FileNode {
    if (ticket !== undefined) {
      this.assertFresh(ticket);
    }
    const res = this.resolve(path);
    if (res.node.kind === "dir") {
      throw new FsError("EISDIR", `is a directory: ${displayPath(res.stack)}`);
    }
    if (res.node.kind !== "file") {
      throw new FsError("ENOENT", `not a regular file: ${displayPath(res.stack)}`);
    }
    res.node.openCount++;
    return res.node;
  }

  readFile(path: string, ticket?: LookupTicket): string {
    return this.open(path, ticket).content;
  }

  private nodeAt(stack: readonly string[]): VNode | undefined {
    let node: VNode = this.vfs.root;
    for (const comp of stack) {
      if (node.kind !== "dir") return undefined;
      const next: VNode | undefined = node.children.get(comp);
      if (next === undefined) return undefined;
      node = next;
    }
    return node;
  }

  private assertFresh(ticket: LookupTicket): void {
    for (const entry of ticket.generations) {
      const node = this.vfs.getRaw(entry.path);
      if (node === undefined || node.kind !== "dir" || node.generation !== entry.generation) {
        throw new FsError(
          "ESTALE",
          `directory ${entry.path} changed between existence check and open; refusing to open`,
        );
      }
    }
  }
}

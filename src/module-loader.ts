import { AsyncLocalStorage } from 'node:async_hooks';

/** A module's source as returned by a {@link Loader}. */
export interface ModuleSource {
  /** IDs of modules this module depends on. */
  dependencies?: string[];
  /** The value the module exports. */
  exports?: unknown;
}

/** Fetches the source of a module by ID. */
export type Loader = (id: string) => ModuleSource | Promise<ModuleSource>;

/** Rejected when a dependency cycle is detected. */
export class CycleError extends Error {
  /**
   * The canonical cycle: the shortest cycle closed by the offending edge,
   * rotated to start at the lexicographically smallest module ID and with
   * that ID repeated at the end, e.g. `['a', 'b', 'c', 'a']`.
   */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

interface CacheEntry {
  generation: number;
  promise: Promise<unknown>;
}

interface LoadContext {
  /** Module IDs on the current loading dependency chain, root first. */
  chain: string[];
  /** Generation of the outermost `load` call this context belongs to. */
  generation: number;
}

/**
 * Loads modules and their dependency graphs.
 *
 * - Concurrent requests for the same ID are merged into one in-flight load.
 * - The current loading dependency chain is tracked per async context, and
 *   requested dependency edges are recorded in a graph. A request that would
 *   close a cycle — along the current chain or between two chains that would
 *   otherwise wait on each other — fails fast with a {@link CycleError}
 *   naming the shortest (then lexicographically smallest) cycle.
 * - Each outermost `load` call forms a generation. If it fails, only cache
 *   entries created by that generation are evicted, so a retry re-fetches
 *   them while older generations stay cached.
 */
export class ModuleLoader {
  private readonly loader: Loader;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly edges = new Map<string, Set<string>>();
  private readonly context = new AsyncLocalStorage<LoadContext>();
  private nextGeneration = 0;

  constructor(loader: Loader) {
    this.loader = loader;
  }

  /** Loads a module and its dependency graph, resolving to its exports. */
  load(id: string): Promise<unknown> {
    const ctx = this.context.getStore();
    const chain = ctx?.chain ?? [];
    const generation = ctx?.generation ?? ++this.nextGeneration;
    const parent = chain.length > 0 ? (chain[chain.length - 1] as string) : undefined;

    // The edge parent -> id is about to be awaited. If id can already reach
    // parent through recorded dependency edges, waiting would close a cycle
    // and deadlock the load (this also covers id being on the current chain,
    // and two separate chains that start waiting on each other). Fail fast
    // with the cycle instead.
    if (parent !== undefined && this.canReach(id, parent)) {
      return Promise.reject(this.buildCycleError(chain, id));
    }

    const cached = this.cache.get(id);
    if (cached !== undefined) {
      // Shared request: join the in-flight (or finished) load instead of
      // starting a second one.
      return cached.promise;
    }

    const promise = this.execute(id, [...chain, id], generation);
    this.cache.set(id, { generation, promise });

    if (ctx === undefined) {
      // Outermost load of this generation: on failure evict only this
      // generation's entries so a retry starts clean.
      return promise.catch((error: unknown) => {
        this.clearGeneration(generation);
        throw error;
      });
    }
    return promise;
  }

  /** Whether `to` is reachable from `from` via recorded dependency edges. */
  private canReach(from: string, to: string): boolean {
    if (from === to) return true;
    const visited = new Set<string>([from]);
    let frontier = [from];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const dep of this.edges.get(node) ?? []) {
          if (dep === to) return true;
          if (!visited.has(dep)) {
            visited.add(dep);
            next.push(dep);
          }
        }
      }
      frontier = next;
    }
    return false;
  }

  private async execute(id: string, chain: string[], generation: number): Promise<unknown> {
    const source = await this.loader(id);
    const dependencies = source.dependencies ?? [];
    this.addEdges(id, dependencies);
    const ctx: LoadContext = { chain, generation };
    await Promise.all(
      dependencies.map((dep) => this.context.run(ctx, () => this.load(dep))),
    );
    return source.exports;
  }

  private addEdges(id: string, dependencies: string[]): void {
    let targets = this.edges.get(id);
    if (targets === undefined) {
      targets = new Set();
      this.edges.set(id, targets);
    }
    for (const dep of dependencies) targets.add(dep);
  }

  private clearGeneration(generation: number): void {
    for (const [id, entry] of this.cache) {
      if (entry.generation === generation) {
        this.cache.delete(id);
        this.edges.delete(id);
      }
    }
  }

  private buildCycleError(chain: string[], id: string): CycleError {
    const parent = chain[chain.length - 1] as string;
    // The new edge parent -> id closes a cycle. The shortest such cycle is
    // parent -> id followed by the shortest path from id back to parent
    // through the dependency edges recorded so far.
    const back = this.shortestPath(id, parent);
    const nodes = [parent, ...back.slice(0, -1)];
    // Rotate so the lexicographically smallest ID comes first.
    let start = 0;
    for (let i = 1; i < nodes.length; i++) {
      if ((nodes[i] as string) < (nodes[start] as string)) start = i;
    }
    const rotated = [...nodes.slice(start), ...nodes.slice(0, start)];
    return new CycleError([...rotated, rotated[0] as string]);
  }

  /**
   * Shortest path from `from` to `to` over recorded dependency edges.
   * Ties are broken by lexicographic order of the node sequence.
   */
  private shortestPath(from: string, to: string): string[] {
    if (from === to) return [from];
    let frontier = new Map<string, string[]>([[from, [from]]]);
    const visited = new Set<string>([from]);
    while (frontier.size > 0) {
      const next = new Map<string, string[]>();
      for (const [node, path] of frontier) {
        for (const dep of this.edges.get(node) ?? []) {
          if (visited.has(dep)) continue;
          const candidate = [...path, dep];
          const existing = next.get(dep);
          if (existing === undefined || comparePaths(candidate, existing) < 0) {
            next.set(dep, candidate);
          }
        }
      }
      const hit = next.get(to);
      if (hit !== undefined) return hit;
      for (const node of next.keys()) visited.add(node);
      frontier = next;
    }
    return [from, to];
  }
}

function comparePaths(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

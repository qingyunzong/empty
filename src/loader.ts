import { AsyncLocalStorage } from 'node:async_hooks';

export type Require = (id: string) => Promise<unknown>;
export type LoaderFn = (id: string, require: Require) => unknown | Promise<unknown>;

export class CycleError extends Error {
  readonly cycle: readonly string[];

  constructor(cycle: string[]) {
    super(`circular dependency: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = Object.freeze([...cycle]);
  }
}

interface LoadContext {
  readonly chain: readonly string[];
  readonly generation: number;
}

interface CacheRecord {
  readonly promise: Promise<unknown>;
  readonly generation: number;
}

/**
 * Rotate the cycle so the lexicographically smallest module id comes first,
 * then close the loop. The chain slice is already the shortest cycle on the
 * current dependency path (chain entries are unique, so the first and only
 * occurrence of the repeated id starts the minimal loop).
 */
function canonicalCycle(nodes: readonly string[]): string[] {
  let smallest = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index]! < nodes[smallest]!) smallest = index;
  }
  const rotated = [...nodes.slice(smallest), ...nodes.slice(0, smallest)];
  return [...rotated, rotated[0]!];
}

export class ModuleLoader {
  private readonly cache = new Map<string, CacheRecord>();
  private readonly context = new AsyncLocalStorage<LoadContext>();
  private nextGeneration = 0;

  constructor(private readonly loader: LoaderFn) {}

  load(id: string): Promise<unknown> {
    const ctx = this.context.getStore();
    if (ctx !== undefined) return this.loadTracked(id, ctx);

    // Top-level load: start a new cache generation. If this load batch fails,
    // only records created within it are evicted; older generations survive.
    const generation = (this.nextGeneration += 1);
    const root: LoadContext = { chain: [], generation };
    const promise = this.context.run(root, () => this.loadTracked(id, root));
    promise.then(undefined, () => this.evictGeneration(generation));
    return promise;
  }

  private loadTracked(id: string, ctx: LoadContext): Promise<unknown> {
    const at = ctx.chain.indexOf(id);
    if (at !== -1) throw new CycleError(canonicalCycle(ctx.chain.slice(at)));

    // Merge same-id requests: an in-flight or cached record is shared, never
    // re-executed and never mistaken for a cycle (the chain check above runs
    // first, so only requests outside the current dependency path reach here).
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached.promise;

    const child: LoadContext = { chain: [...ctx.chain, id], generation: ctx.generation };
    const require: Require = (dep) => this.load(dep);
    const promise = Promise.resolve().then(() =>
      this.context.run(child, () => this.loader(id, require)),
    );
    this.cache.set(id, { promise, generation: ctx.generation });
    return promise;
  }

  private evictGeneration(generation: number): void {
    for (const [id, record] of this.cache) {
      if (record.generation === generation) this.cache.delete(id);
    }
  }
}

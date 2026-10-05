import type { ModuleSource } from './module-loader.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * A scriptable loader for tests and demos. Modules are defined up front,
 * every fetch is counted, single fetches can be held with gates, and
 * failures can be scheduled for a chosen number of attempts.
 */
export class ControllableLoader {
  private readonly sources = new Map<string, ModuleSource>();
  private readonly callCounts = new Map<string, number>();
  private readonly failures = new Map<string, { error: unknown; remaining: number }>();
  private readonly gates = new Map<string, Deferred[]>();
  private readonly waiters = new Map<string, { times: number; resolve: () => void }[]>();

  /** Registers (or replaces) a module. Returns `this` for chaining. */
  define(id: string, source: ModuleSource): this {
    this.sources.set(id, source);
    return this;
  }

  /** How many times the module's source has been fetched. */
  calls(id: string): number {
    return this.callCounts.get(id) ?? 0;
  }

  /** Makes the next `times` fetches of `id` reject with `error`. */
  failNext(id: string, error: unknown, times = 1): this {
    this.failures.set(id, { error, remaining: times });
    return this;
  }

  /** Holds the next fetch of `id` until {@link release} is called. */
  gate(id: string): this {
    const list = this.gates.get(id) ?? [];
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    list.push({ promise, resolve });
    this.gates.set(id, list);
    return this;
  }

  /** Releases every pending gate on `id`. */
  release(id: string): void {
    for (const gate of this.gates.get(id) ?? []) gate.resolve();
    this.gates.delete(id);
  }

  /** Resolves once `id` has been fetched at least `times` times. */
  whenCalled(id: string, times = 1): Promise<void> {
    if (this.calls(id) >= times) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push({ times, resolve });
      this.waiters.set(id, list);
    });
  }

  /** The loader function to hand to `ModuleLoader`. */
  readonly load = async (id: string): Promise<ModuleSource> => {
    const count = this.calls(id) + 1;
    this.callCounts.set(id, count);
    for (const waiter of this.waiters.get(id) ?? []) {
      if (waiter.times <= count) waiter.resolve();
    }
    this.waiters.set(
      id,
      (this.waiters.get(id) ?? []).filter((waiter) => waiter.times > count),
    );

    const gate = this.gates.get(id)?.[0];
    if (gate !== undefined) await gate.promise;

    const failure = this.failures.get(id);
    if (failure !== undefined && failure.remaining > 0) {
      failure.remaining -= 1;
      throw failure.error;
    }

    const source = this.sources.get(id);
    if (source === undefined) {
      throw new Error(`ControllableLoader: no module defined for "${id}"`);
    }
    return source;
  };
}

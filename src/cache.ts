import { isDeepStrictEqual } from "node:util";
import { DependencyGraph } from "./graph.js";
import type { FileStore } from "./store.js";

/** Operations available to a running build task. */
export interface TaskContext {
  /** Read an input file, recording (path, version) as a dependency. */
  readFile(path: string): string;
  /** Read another artifact, building it first if needed, and record the dependency. */
  read<T = unknown>(key: string): Promise<T>;
}

export type Builder<T> = (ctx: TaskContext) => T | Promise<T>;

export interface DefineOptions<T> {
  /** Initial value used when a dependency cycle is built before any cached value exists. */
  seed?: (() => T) | undefined;
  /** Equality used for fixpoint convergence and verification. Defaults to deep strict equality. */
  equals?: ((a: T, b: T) => boolean) | undefined;
}

export interface CacheEntry<T = unknown> {
  readonly value: T;
  readonly version: string;
  /** Dependency key -> version observed when the task read it. */
  readonly deps: ReadonlyMap<string, string>;
}

/** A cycle discovered while building, with a concrete witness path. */
export interface CycleRecord {
  /** Keys forming the cyclic group. */
  readonly group: readonly string[];
  /** Concrete path [k0, k1, ..., k0]; every consecutive pair is a real dependency. */
  readonly evidence: readonly string[];
}

export interface InvalidationResult {
  /** Reverse-reachable closure of the changed keys (what was considered). */
  readonly closure: ReadonlySet<string>;
  /** Cached entries actually evicted. */
  readonly evicted: readonly string[];
}

export type MismatchKind =
  | "value"
  | "deps"
  | "missing-in-cache"
  | "missing-in-recompute"
  | "recompute-error";

export interface VerifyMismatch {
  readonly key: string;
  readonly kind: MismatchKind;
  readonly detail: string;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly mismatches: readonly VerifyMismatch[];
  /** Cycles present in the dependency graph, each with an evidence path. */
  readonly cycles: readonly { members: string[]; evidence: string[] }[];
}

export interface BuildCacheOptions {
  /** How often a task is re-run when its inputs change mid-build before giving up. */
  maxRetries?: number;
  /** Fixpoint iteration bound for cyclic groups. */
  maxCycleIterations?: number;
}

interface TaskDef {
  builder: Builder<unknown>;
  seed: (() => unknown) | undefined;
  equals: (a: unknown, b: unknown) => boolean;
}

/** Internal control-flow signal: a task requested an artifact already on the build stack. */
class CycleSignal extends Error {
  constructor(readonly group: string[]) {
    super(`dependency cycle: ${[...group, group[0]].join(" -> ")}`);
  }
}

/** Per-task-run dependency recording. `null` version = intra-cycle dep, stamped at group publish. */
type Frame = Map<string, string | null>;

export class BuildCache {
  /** Dependency graph updated after every published build. */
  readonly graph = new DependencyGraph();
  readonly maxRetries: number;
  readonly maxCycleIterations: number;

  private readonly defs = new Map<string, TaskDef>();
  private readonly entries = new Map<string, CacheEntry>();
  private stamp = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCycleRecords: CycleRecord[] = [];
  private lastRetryRecords: Array<{ key: string; attempt: number }> = [];

  constructor(readonly store: FileStore, options: BuildCacheOptions = {}) {
    this.maxRetries = options.maxRetries ?? 4;
    this.maxCycleIterations = options.maxCycleIterations ?? 32;
  }

  define<T>(key: string, builder: Builder<T>, options: DefineOptions<T> = {}): void {
    this.defs.set(key, {
      builder: builder as Builder<unknown>,
      seed: options.seed as (() => unknown) | undefined,
      equals:
        (options.equals as ((a: unknown, b: unknown) => boolean) | undefined) ??
        ((a, b) => isDeepStrictEqual(a, b)),
    });
  }

  has(key: string): boolean {
    return this.defs.has(key);
  }

  getEntry(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  /** Cycles encountered (and resolved) during the most recent build(). */
  lastCycles(): readonly CycleRecord[] {
    return this.lastCycleRecords;
  }

  /** Tasks re-run during the most recent build() because inputs changed mid-flight. */
  lastRetries(): readonly { key: string; attempt: number }[] {
    return this.lastRetryRecords;
  }

  /**
   * Batch invalidation: evicts exactly the reverse-reachable closure of
   * `changed` in the dependency graph. Everything else stays cached.
   */
  invalidate(changed: Iterable<string>): InvalidationResult {
    const closure = this.graph.reverseClosure(changed);
    const evicted: string[] = [];
    for (const key of closure) {
      if (this.entries.delete(key)) evicted.push(key);
    }
    return { closure, evicted };
  }

  /** Build `key` (and anything it depends on), reusing fresh cache entries. */
  async build<T = unknown>(key: string): Promise<T> {
    return this.enqueue(async () => {
      const session = new Session(this, true, this.entries, () => `v${++this.stamp}`);
      const value = await session.ensure(key);
      this.lastCycleRecords = session.cycleRecords;
      this.lastRetryRecords = session.retryRecords;
      return value as T;
    });
  }

  /**
   * Full-graph recomputation check: rebuilds every cached key from scratch
   * (ignoring the cache) and compares values and dependency sets against the
   * incremental results. The cache itself is left untouched.
   */
  async verify(): Promise<VerifyReport> {
    return this.enqueue(async () => {
      const shadowEntries = new Map<string, CacheEntry>();
      let shadowStamp = 0;
      const session = new Session(this, false, shadowEntries, () => `shadow-v${++shadowStamp}`);
      const mismatches: VerifyMismatch[] = [];

      for (const key of this.entries.keys()) {
        try {
          await session.ensure(key);
        } catch (err) {
          mismatches.push({
            key,
            kind: "recompute-error",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      for (const [key, cached] of this.entries) {
        const fresh = shadowEntries.get(key);
        if (!fresh) {
          if (!mismatches.some((m) => m.key === key)) {
            mismatches.push({ key, kind: "missing-in-recompute", detail: "cached but not reproduced" });
          }
          continue;
        }
        const def = this.def(key);
        if (!def.equals(fresh.value, cached.value)) {
          mismatches.push({
            key,
            kind: "value",
            detail: `cache=${JSON.stringify(cached.value)} recompute=${JSON.stringify(fresh.value)}`,
          });
        }
        const cachedDeps = [...cached.deps.keys()].sort();
        const freshDeps = [...fresh.deps.keys()].sort();
        if (!isDeepStrictEqual(cachedDeps, freshDeps)) {
          mismatches.push({
            key,
            kind: "deps",
            detail: `cache=[${cachedDeps.join(",")}] recompute=[${freshDeps.join(",")}]`,
          });
        }
      }

      return { ok: mismatches.length === 0, mismatches, cycles: this.graph.cycles() };
    });
  }

  def(key: string): TaskDef {
    const def = this.defs.get(key);
    if (!def) throw new Error(`unknown build target: ${key}`);
    return def;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

class Session {
  readonly cycleRecords: CycleRecord[] = [];
  readonly retryRecords: Array<{ key: string; attempt: number }> = [];

  private readonly building = new Set<string>();
  private readonly stack: string[] = [];
  private readonly activeGroups = new Map<string, Map<string, unknown>>();
  private readonly recycled = new Map<string, unknown>();

  constructor(
    private readonly cache: BuildCache,
    private readonly useCache: boolean,
    readonly entries: Map<string, CacheEntry>,
    private readonly nextStamp: () => string,
  ) {}

  async ensure(key: string): Promise<unknown> {
    const groupValues = this.activeGroups.get(key);
    if (groupValues) return groupValues.get(key);

    if (this.building.has(key)) {
      const idx = this.stack.indexOf(key);
      const group = this.stack.slice(idx);
      this.recordCycle(group, [...group, key]);
      throw new CycleSignal(group);
    }

    if (this.useCache) {
      const entry = this.entries.get(key);
      if (entry) {
        if (await this.isFresh(key, entry, new Set())) return entry.value;
        // Stale: drop the whole strongly connected component so cyclic
        // groups are always rebuilt as a unit. Values are recycled as seeds.
        for (const member of this.sccOf(key)) {
          const stale = this.entries.get(member);
          if (stale) this.recycled.set(member, stale.value);
          this.entries.delete(member);
        }
      }
    }

    this.building.add(key);
    this.stack.push(key);
    try {
      return await this.runWithRetries(key);
    } catch (err) {
      if (err instanceof CycleSignal && err.group[0] === key) {
        return await this.runGroupFixpoint(err.group);
      }
      throw err;
    } finally {
      this.building.delete(key);
      this.stack.pop();
    }
  }

  private async runWithRetries(key: string): Promise<unknown> {
    const def = this.cache.def(key);
    for (let attempt = 1; ; attempt++) {
      const frame: Frame = new Map();
      const value = await def.builder(this.makeContext(frame));
      // Publish only if every input still has the version the task observed.
      if (this.depsConsistent(frame)) {
        this.publish(key, value, frame, this.nextStamp());
        return value;
      }
      if (attempt >= this.cache.maxRetries) {
        throw new Error(`build of "${key}" never observed stable inputs (${attempt} attempts)`);
      }
      this.retryRecords.push({ key, attempt });
    }
  }

  private async runGroupFixpoint(group: string[]): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const values = this.initialGroupValues(group);
      const frames = new Map<string, Frame>();
      for (const key of group) this.activeGroups.set(key, values);

      let converged = false;
      let iterations = 0;
      try {
        while (!converged && iterations < this.cache.maxCycleIterations) {
          iterations++;
          converged = true;
          for (const key of group) {
            const def = this.cache.def(key);
            const frame: Frame = new Map();
            const value = await def.builder(this.makeContext(frame));
            frames.set(key, frame);
            if (!def.equals(value, values.get(key))) {
              values.set(key, value);
              converged = false;
            }
          }
        }
      } finally {
        for (const key of group) this.activeGroups.delete(key);
      }

      if (!converged) {
        throw new Error(
          `dependency cycle ${group.join(" -> ")} did not converge within ${this.cache.maxCycleIterations} iterations`,
        );
      }

      // Version-check the whole group's inputs before publishing anything.
      const consistent = [...frames.values()].every((frame) => this.depsConsistent(frame));
      if (consistent) {
        const version = this.nextStamp();
        for (const key of group) {
          this.publish(key, values.get(key), frames.get(key) as Frame, version);
        }
        return values.get(group[0] as string);
      }
      if (attempt >= this.cache.maxRetries) {
        throw new Error(`cyclic group ${group.join(", ")} never observed stable inputs`);
      }
      for (const key of group) this.retryRecords.push({ key, attempt });
    }
  }

  private initialGroupValues(group: string[]): Map<string, unknown> {
    const values = new Map<string, unknown>();
    for (const key of group) {
      const existing = this.entries.get(key)?.value ?? this.recycled.get(key);
      if (existing !== undefined) {
        values.set(key, existing);
        continue;
      }
      const def = this.cache.def(key);
      if (!def.seed) {
        throw new Error(
          `cyclic task "${key}" has no cached value and no seed; pass { seed } to define()`,
        );
      }
      values.set(key, def.seed());
    }
    return values;
  }

  private makeContext(frame: Frame): TaskContext {
    return {
      readFile: (path: string): string => {
        frame.set(path, this.cache.store.version(path));
        return this.cache.store.read(path);
      },
      read: async <T>(dep: string): Promise<T> => {
        if (!this.cache.has(dep)) throw new Error(`unknown build target: ${dep}`);
        const value = await this.ensure(dep);
        frame.set(dep, this.activeGroups.has(dep) ? null : this.currentVersion(dep));
        return value as T;
      },
    };
  }

  private publish(key: string, value: unknown, frame: Frame, version: string): void {
    const deps = new Map<string, string>();
    for (const [dep, recorded] of frame) deps.set(dep, recorded ?? version);
    this.entries.set(key, { value, version, deps });
    if (this.useCache) this.cache.graph.recordDependencies(key, deps.keys());
  }

  private depsConsistent(frame: Frame): boolean {
    for (const [dep, recorded] of frame) {
      if (recorded === null) continue; // intra-cycle dep, published under one stamp
      if (this.currentVersion(dep) !== recorded) return false;
    }
    return true;
  }

  private currentVersion(dep: string): string {
    if (this.cache.has(dep)) return this.entries.get(dep)?.version ?? "<unbuilt>";
    return this.cache.store.version(dep);
  }

  private async isFresh(key: string, entry: CacheEntry, visiting: Set<string>): Promise<boolean> {
    if (visiting.has(key)) return true; // cyclic groups share one stamp; checked by version equality
    visiting.add(key);
    for (const [dep, recorded] of entry.deps) {
      if (this.cache.has(dep)) {
        const depEntry = this.entries.get(dep);
        if (!depEntry || depEntry.version !== recorded) return false;
        if (!(await this.isFresh(dep, depEntry, visiting))) return false;
      } else if (this.cache.store.version(dep) !== recorded) {
        return false;
      }
    }
    visiting.delete(key);
    return true;
  }

  private sccOf(key: string): string[] {
    for (const scc of this.cache.graph.stronglyConnectedComponents()) {
      if (scc.includes(key)) return scc;
    }
    return [key];
  }

  private recordCycle(group: string[], evidence: string[]): void {
    const fingerprint = evidence.join("→");
    if (!this.cycleRecords.some((c) => c.evidence.join("→") === fingerprint)) {
      this.cycleRecords.push({ group, evidence });
    }
  }
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DepGraph, Key } from "./graph";

export type Version = string;

/** Context handed to a task while it (re)runs; every access declares a dependency. */
export interface RunContext {
  /** Declare a dependency and get its current version. */
  depend(key: Key): Version;
  /** Declare a dependency and get its current value (source content or artifact). */
  read(key: Key): unknown;
}

export type TaskFn = (ctx: RunContext) => unknown;

export interface TaskRecord {
  key: Key;
  /** Input versions captured at run time; must match before the result is published. */
  deps: ReadonlyMap<Key, Version>;
  version: Version;
  value: unknown;
  dirty: boolean;
}

export interface VerifyReport {
  consistent: boolean;
  mismatches: Key[];
  checked: Key[];
}

interface Resolved {
  version: Version;
  value: unknown;
}

const hashValue = (value: unknown): Version =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
};

export class BuildCache {
  private sources = new Map<Key, { version: Version; content: unknown }>();
  private tasks = new Map<Key, TaskFn>();
  private records = new Map<Key, TaskRecord & { deps: Map<Key, Version> }>();
  private graph = new DepGraph();
  private pendingChanges = new Set<Key>();
  private inProgress = new Set<Key>();
  private readonly maxFixpointRounds: number;

  /** Number of times each task body actually executed (for tests/diagnostics). */
  readonly runCounts = new Map<Key, number>();

  constructor(options: { maxFixpointRounds?: number } = {}) {
    this.maxFixpointRounds = options.maxFixpointRounds ?? 32;
  }

  registerTask(key: Key, fn: TaskFn): void {
    this.tasks.set(key, fn);
  }

  /** Register or update a source file's content; batches up as a pending change. */
  setSource(key: Key, content: unknown): void {
    const version = hashValue(content);
    const prev = this.sources.get(key);
    this.sources.set(key, { version, content });
    if (!prev || prev.version !== version) this.pendingChanges.add(key);
  }

  setSourceFile(key: Key, path: string): void {
    this.setSource(key, readFileSync(path, "utf8"));
  }

  versionOf(key: Key): Version | undefined {
    return this.sources.get(key)?.version ?? this.records.get(key)?.version;
  }

  depsOf(key: Key): Set<Key> {
    return new Set(this.records.get(key)?.deps.keys() ?? []);
  }

  /**
   * Invalidate exactly the reverse-reachable closure of all pending changes.
   * Returns the affected keys (changed sources plus dependent artifacts).
   */
  invalidate(): Set<Key> {
    const affected = this.graph.reverseClosure(this.pendingChanges);
    this.pendingChanges.clear();
    for (const key of affected) {
      const rec = this.records.get(key);
      if (rec) rec.dirty = true;
    }
    return affected;
  }

  /** Cycle evidence for the current graph, e.g. [["A", "B", "A"]]. */
  cycles(): Key[][] {
    return this.graph.cycles();
  }

  build(target: Key): unknown {
    this.invalidate();
    for (let round = 1; round <= this.maxFixpointRounds; round++) {
      this.ensure(target, new Set());
      const inconsistent = this.inconsistentReachable(target);
      if (inconsistent.length === 0) {
        const rec = this.records.get(target);
        if (rec) return rec.value;
        const src = this.sources.get(target);
        if (src) return src.content;
        throw new Error(`No task or source registered for "${target}"`);
      }
      // Cyclic group has not reached a fixpoint yet; force another pass.
      for (const key of inconsistent) {
        const rec = this.records.get(key);
        if (rec) rec.dirty = true;
      }
    }
    const evidence = this.cycles()
      .map((c) => c.join(" -> "))
      .join("; ");
    throw new Error(
      `Cyclic build for "${target}" did not converge within ${this.maxFixpointRounds} rounds` +
        (evidence ? `; cycle evidence: ${evidence}` : "")
    );
  }

  /**
   * Full-graph recompute check: rebuild every requested target from scratch
   * and compare versions against the incrementally produced results.
   */
  verify(targets?: Key[]): VerifyReport {
    const keys = targets ?? [...this.tasks.keys()];
    const expected = new Map<Key, Version>();
    for (const key of keys) {
      this.build(key);
      const rec = this.records.get(key);
      if (rec) expected.set(key, rec.version);
    }
    this.records.clear();
    this.graph = new DepGraph();
    const mismatches: Key[] = [];
    for (const key of keys) {
      this.build(key);
      const rec = this.records.get(key);
      if (rec && rec.version !== expected.get(key)) mismatches.push(key);
    }
    return {
      consistent: mismatches.length === 0,
      mismatches,
      checked: [...expected.keys()],
    };
  }

  /**
   * Resolve a key to an up-to-date version/value. A cached record is only
   * published after every recorded input version has been re-checked.
   */
  private ensure(key: Key, checking: Set<Key>): Resolved {
    const task = this.tasks.get(key);
    const source = this.sources.get(key);
    if (!task) {
      if (source) return { version: source.version, value: source.content };
      throw new Error(`No task or source registered for "${key}"`);
    }
    const rec = this.records.get(key);
    if (rec && !rec.dirty) {
      if (checking.has(key)) return { version: rec.version, value: rec.value };
      checking.add(key);
      let publishable = true;
      for (const [dep, recordedVersion] of rec.deps) {
        const cur = this.ensure(dep, checking);
        if (cur.version !== recordedVersion) {
          publishable = false;
          break;
        }
      }
      checking.delete(key);
      if (publishable) return { version: rec.version, value: rec.value };
    }
    if (this.inProgress.has(key)) {
      // Cyclic dependency: hand back the stale/pending record; the fixpoint
      // rounds in build() will re-check its version and rebuild if needed.
      return { version: rec?.version ?? `pending:${key}`, value: rec?.value };
    }
    return this.runTask(key);
  }

  private runTask(key: Key): Resolved {
    const fn = this.tasks.get(key)!;
    this.inProgress.add(key);
    try {
      const captured = new Map<Key, Version>();
      const ctx: RunContext = {
        depend: (dep) => {
          const r = this.ensure(dep, new Set());
          captured.set(dep, r.version);
          return r.version;
        },
        read: (dep) => {
          const r = this.ensure(dep, new Set());
          captured.set(dep, r.version);
          return r.value;
        },
      };
      const value = fn(ctx);
      const version = hashValue(value);
      this.runCounts.set(key, (this.runCounts.get(key) ?? 0) + 1);
      this.records.set(key, { key, deps: captured, version, value, dirty: false });
      // Dependencies may have changed during the rebuild: replace the edges.
      this.graph.setDeps(key, captured.keys());
      return { version, value };
    } finally {
      this.inProgress.delete(key);
    }
  }

  /** Reachable records whose captured input versions no longer match reality. */
  private inconsistentReachable(target: Key): Key[] {
    const reachable = this.graph.forwardClosure(target);
    const inconsistent: Key[] = [];
    for (const key of reachable) {
      const rec = this.records.get(key);
      if (!rec) continue;
      for (const [dep, recordedVersion] of rec.deps) {
        if (this.versionOf(dep) !== recordedVersion) {
          inconsistent.push(key);
          break;
        }
      }
    }
    return inconsistent;
  }
}

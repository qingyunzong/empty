/**
 * Dependency DAG used to derive observation weights from raw sources.
 *
 * Node kinds:
 *  - source:       an externally supplied number.
 *  - derived:      pure function of a static list of dependencies.
 *  - conditional:  evaluates its condition dependencies, selects a branch,
 *                  and only then evaluates that branch's dependencies.
 *                  Dependencies of unselected branches are never evaluated.
 *
 * DagEngine evaluates lazily and incrementally: a source change dirties its
 * transitive dependents (along the dependency edges actually used in the
 * previous generation) and only dirty nodes are recomputed on demand.
 *
 * evaluateDagModel is the independent reference model: a plain memoized
 * full evaluation from scratch, used by tests to cross-check the engine.
 */

export type NodeSpec =
  | { kind: "source" }
  | { kind: "derived"; deps: string[]; compute: (vals: number[]) => number }
  | {
      kind: "conditional";
      conditionDeps: string[];
      select: (vals: number[]) => string;
      branches: Record<string, { deps: string[]; compute: (vals: number[]) => number }>;
    };

export class DagError extends Error {}

export class DagEngine {
  private readonly specs = new Map<string, NodeSpec>();
  private readonly sourceValues = new Map<string, number>();
  private readonly values = new Map<string, number>();
  private readonly usedDeps = new Map<string, string[]>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  /** Instrumentation: number of node (re)computations performed. */
  computeCalls = 0;

  addSource(name: string, initial: number): void {
    this.assertNew(name);
    if (!Number.isFinite(initial)) throw new DagError(`source ${name} must be finite`);
    this.specs.set(name, { kind: "source" });
    this.sourceValues.set(name, initial);
  }

  addNode(name: string, spec: Exclude<NodeSpec, { kind: "source" }>): void {
    this.assertNew(name);
    this.specs.set(name, spec);
  }

  hasNode(name: string): boolean {
    return this.specs.has(name);
  }

  getSources(): ReadonlyMap<string, number> {
    return new Map(this.sourceValues);
  }

  getSpecs(): ReadonlyMap<string, NodeSpec> {
    return new Map(this.specs);
  }

  /** Apply a batch of source changes as one logical update. */
  applySourceChanges(changes: Iterable<readonly [string, number]>): void {
    for (const [name, value] of changes) {
      if (!this.sourceValues.has(name)) throw new DagError(`unknown source: ${name}`);
      if (!Number.isFinite(value)) throw new DagError(`source ${name} must be finite`);
      if (Object.is(this.sourceValues.get(name), value)) continue;
      this.sourceValues.set(name, value);
      // Sources are read directly from sourceValues, so they never enter the
      // dirty set themselves; only their dependents need recomputation.
      for (const dependent of this.dependents.get(name) ?? []) this.markDirty(dependent);
    }
  }

  /** Evaluate one node, recomputing only what is dirty. */
  evaluate(name: string): number {
    return this.evalNode(name, new Set());
  }

  /** Evaluate the given output nodes into a fresh map. */
  evaluateOutputs(outputs: Iterable<string>): Map<string, number> {
    const out = new Map<string, number>();
    for (const name of outputs) out.set(name, this.evaluate(name));
    return out;
  }

  private assertNew(name: string): void {
    if (this.specs.has(name)) throw new DagError(`duplicate node: ${name}`);
  }

  private markDirty(name: string): void {
    if (this.dirty.has(name)) return;
    this.dirty.add(name);
    for (const dependent of this.dependents.get(name) ?? []) this.markDirty(dependent);
  }

  private evalNode(name: string, visiting: Set<string>): number {
    const spec = this.specs.get(name);
    if (spec === undefined) throw new DagError(`unknown node: ${name}`);
    if (spec.kind === "source") return this.sourceValues.get(name) as number;
    if (!this.dirty.has(name) && this.values.has(name)) return this.values.get(name) as number;
    if (visiting.has(name)) throw new DagError(`dependency cycle at node: ${name}`);
    visiting.add(name);
    let deps: string[];
    let value: number;
    if (spec.kind === "derived") {
      deps = spec.deps;
      value = spec.compute(deps.map((d) => this.evalNode(d, visiting)));
    } else {
      const conditionVals = spec.conditionDeps.map((d) => this.evalNode(d, visiting));
      const branchKey = spec.select(conditionVals);
      const branch = spec.branches[branchKey];
      if (branch === undefined) {
        throw new DagError(`conditional node ${name}: no branch named "${branchKey}"`);
      }
      const branchVals = branch.deps.map((d) => this.evalNode(d, visiting));
      deps = [...spec.conditionDeps, ...branch.deps];
      value = branch.compute(branchVals);
    }
    visiting.delete(name);
    this.computeCalls++;
    this.setUsedDeps(name, deps);
    this.values.set(name, value);
    this.dirty.delete(name);
    return value;
  }

  private setUsedDeps(name: string, deps: string[]): void {
    for (const old of this.usedDeps.get(name) ?? []) this.dependents.get(old)?.delete(name);
    const unique = [...new Set(deps)];
    this.usedDeps.set(name, unique);
    for (const dep of unique) {
      let set = this.dependents.get(dep);
      if (set === undefined) {
        set = new Set();
        this.dependents.set(dep, set);
      }
      set.add(name);
    }
  }
}

/**
 * Reference model: full memoized evaluation of `outputs` from scratch.
 * Shares no state with any DagEngine, so tests can use it to verify the
 * incremental engine produces identical results.
 */
export function evaluateDagModel(
  specs: ReadonlyMap<string, NodeSpec>,
  sources: ReadonlyMap<string, number>,
  outputs: Iterable<string>
): Map<string, number> {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const evalNode = (name: string): number => {
    const spec = specs.get(name);
    if (spec === undefined) throw new DagError(`unknown node: ${name}`);
    if (spec.kind === "source") {
      const v = sources.get(name);
      if (v === undefined) throw new DagError(`missing source value: ${name}`);
      return v;
    }
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) throw new DagError(`dependency cycle at node: ${name}`);
    visiting.add(name);
    let value: number;
    if (spec.kind === "derived") {
      value = spec.compute(spec.deps.map(evalNode));
    } else {
      const branchKey = spec.select(spec.conditionDeps.map(evalNode));
      const branch = spec.branches[branchKey];
      if (branch === undefined) {
        throw new DagError(`conditional node ${name}: no branch named "${branchKey}"`);
      }
      value = branch.compute(branch.deps.map(evalNode));
    }
    visiting.delete(name);
    memo.set(name, value);
    return value;
  };

  const out = new Map<string, number>();
  for (const name of outputs) out.set(name, evalNode(name));
  return out;
}

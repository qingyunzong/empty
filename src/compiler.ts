import { sha256, type Hash } from "./hash.js";
import { sccTopoOrder } from "./graph.js";
import { summarize, type ModuleSource, type ModuleSummary } from "./summaries.js";
import type { ArtifactStore } from "./store.js";

/** A publishable unit: one module, or one SCC of cyclic modules. */
export interface ComponentPlan {
  /** Human-readable id: member names joined with "+". */
  readonly id: string;
  readonly members: readonly string[];
  /** Cache key: own iface+impl hashes plus iface hashes of direct deps. */
  readonly key: Hash;
}

export interface BuildResult {
  readonly plans: readonly ComponentPlan[];
  /** Component ids actually (re)compiled in this build. */
  readonly compiled: readonly string[];
  /** Component ids served from the cache. */
  readonly reused: readonly string[];
  /** Component id -> published artifact hash. */
  readonly artifacts: ReadonlyMap<string, Hash>;
  readonly summaries: readonly ModuleSummary[];
}

/**
 * Plan components from module summaries.
 *
 * Cache-key design (the heart of the interface/implementation split):
 *  - own part: every member's (name, ifaceHash, implHash);
 *  - dep part: for every cross-component import edge, the *interface* hash
 *    of the imported module.
 *
 * Consequences:
 *  - impl-only edit in a dependency -> dependent key unchanged -> cache hit;
 *  - interface edit in a dependency -> dependent key changes -> recompiled;
 *  - any edit inside an SCC -> the whole SCC key changes -> batch recompile.
 */
export function planComponents(summaries: readonly ModuleSummary[]): ComponentPlan[] {
  const byName = new Map(summaries.map((s) => [s.name, s]));
  const edges = new Map<string, readonly string[]>(
    summaries.map((s) => [
      s.name,
      s.imports.filter((imp) => imp !== s.name && byName.has(imp)),
    ]),
  );
  const components = sccTopoOrder(
    summaries.map((s) => s.name),
    edges,
  );
  const componentOf = new Map<string, number>();
  components.forEach((members, i) => {
    for (const m of members) componentOf.set(m, i);
  });

  return components.map((members) => {
    const ownPart = members.map((m) => {
      const s = byName.get(m)!;
      return `${m}:${s.ifaceHash}:${s.implHash}`;
    });
    const depPart: string[] = [];
    for (const m of members) {
      for (const imp of edges.get(m)!) {
        if (componentOf.get(imp) !== componentOf.get(m)) {
          depPart.push(`${m}->${imp}:${byName.get(imp)!.ifaceHash}`);
        }
      }
    }
    depPart.sort();
    return {
      id: members.join("+"),
      members,
      key: sha256("component", ...ownPart, ...depPart),
    };
  });
}

/** Deterministic "codegen": the artifact is a pure function of the key. */
export function compileArtifact(plan: ComponentPlan): Hash {
  return sha256("artifact", plan.key);
}

export class Compiler {
  constructor(private readonly store: ArtifactStore) {}

  build(sources: readonly ModuleSource[]): BuildResult {
    const summaries = sources.map(summarize);
    const plans = planComponents(summaries);
    const compiled: string[] = [];
    const reused: string[] = [];
    const artifacts = new Map<string, Hash>();
    for (const plan of plans) {
      let artifact = this.store.get(plan.key);
      if (artifact === undefined) {
        artifact = compileArtifact(plan);
        this.store.put(plan.key, artifact);
        compiled.push(plan.id);
      } else {
        reused.push(plan.id);
      }
      artifacts.set(plan.id, artifact);
    }
    return { plans, compiled, reused, artifacts, summaries };
  }
}

/** Reference model: a full from-scratch compile with a cold cache. */
export function fullCompile(
  sources: readonly ModuleSource[],
  store: ArtifactStore,
): BuildResult {
  return new Compiler(store).build(sources);
}

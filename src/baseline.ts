import { sha256, type Hash } from "./hash.js";
import type { BuildResult } from "./compiler.js";
import type { ArtifactStore } from "./store.js";

/**
 * A baseline is the sealed record of a finished compile task. Resuming an
 * old task starts by verifying the baseline against the artifact store so
 * that a corrupted or partially-evicted cache is detected before reuse.
 */
export interface BaselineModule {
  readonly ifaceHash: Hash;
  readonly implHash: Hash;
  readonly imports: readonly string[];
}

export interface BaselineComponent {
  readonly members: readonly string[];
  readonly key: Hash;
  readonly artifact: Hash;
}

export interface Baseline {
  readonly version: 1;
  readonly modules: Record<string, BaselineModule>;
  readonly components: Record<string, BaselineComponent>;
  /** Hash over the two records above; seals the baseline. */
  readonly manifest: Hash;
}

function computeManifest(
  modules: Record<string, BaselineModule>,
  components: Record<string, BaselineComponent>,
): Hash {
  const parts: string[] = [];
  for (const name of Object.keys(modules).sort()) {
    const m = modules[name]!;
    parts.push(`mod:${name}:${m.ifaceHash}:${m.implHash}:${[...m.imports].sort().join(",")}`);
  }
  for (const id of Object.keys(components).sort()) {
    const c = components[id]!;
    parts.push(`comp:${id}:${c.key}:${c.artifact}`);
  }
  return sha256("manifest", ...parts);
}

export function makeBaseline(result: BuildResult): Baseline {
  const modules: Record<string, BaselineModule> = {};
  for (const s of result.summaries) {
    modules[s.name] = { ifaceHash: s.ifaceHash, implHash: s.implHash, imports: s.imports };
  }
  const components: Record<string, BaselineComponent> = {};
  for (const plan of result.plans) {
    components[plan.id] = {
      members: plan.members,
      key: plan.key,
      artifact: result.artifacts.get(plan.id)!,
    };
  }
  return { version: 1, modules, components, manifest: computeManifest(modules, components) };
}

export interface BaselineReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Component ids whose cache entries were evicted during verification. */
  readonly evicted: readonly string[];
}

/**
 * Verify an old task's baseline against the artifact store. Every invalid
 * entry is evicted so the next build recompiles exactly those components.
 */
export function resumeBaseline(baseline: Baseline, store: ArtifactStore): BaselineReport {
  const problems: string[] = [];
  const evicted: string[] = [];

  if (computeManifest(baseline.modules, baseline.components) !== baseline.manifest) {
    problems.push("manifest mismatch: baseline was tampered with or corrupted");
  }

  for (const [id, component] of Object.entries(baseline.components)) {
    const stored = store.get(component.key);
    if (stored === undefined) {
      problems.push(`component ${id}: artifact missing from store`);
      evicted.push(id);
    } else if (stored !== component.artifact) {
      problems.push(`component ${id}: artifact hash mismatch, evicting`);
      store.delete(component.key);
      evicted.push(id);
    }
  }
  return { ok: problems.length === 0, problems, evicted };
}

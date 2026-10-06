/**
 * Export linker.
 *
 * Merges, for every module in a graph, its explicit exports, its
 * `export * from` (star) re-exports and its aliased re-exports
 * (`export { a as b } from ...`) into a single resolved export map.
 *
 * Rules:
 *  - Explicit exports (local or aliased re-export) take priority over
 *    names that would otherwise arrive through star exports.
 *  - A name arriving through star exports from two *different* origin
 *    bindings is ambiguous: it is reported and not exported.
 *  - The same origin binding arriving through multiple paths is NOT
 *    ambiguous; the shortest path wins.
 *
 * Cyclic graphs are handled by a fixed-point computation: every round
 * re-merges the whole graph from the previous round (the reference),
 * and rounds are compared for convergence. Name sets grow monotonically
 * and origins are stable, so the iteration always terminates.
 */

/** Identity of a binding: the module that defines it plus the local name. */
export interface BindingRef {
  module: string;
  name: string;
}

export interface ExplicitExport {
  /** Name visible to importers of this module. */
  exportedName: string;
  /** Local binding name; defaults to `exportedName`. Ignored when `source` is set. */
  localName?: string;
  /** Re-export: path of the source module. */
  source?: string;
  /** Name imported from the source module; defaults to `exportedName`. */
  importedName?: string;
}

export interface ModuleSpec {
  path: string;
  /** Explicit exports: local declarations and aliased re-exports. */
  exports?: ExplicitExport[];
  /** Star re-exports: `export * from <path>`. */
  starExports?: string[];
}

export interface ResolvedExport {
  name: string;
  /** The binding this name ultimately refers to. */
  origin: BindingRef;
  /** Chain of module paths from the exporting module to the origin module. */
  path: string[];
}

export type Diagnostic =
  | {
      type: "ambiguous-star-export";
      module: string;
      name: string;
      origins: BindingRef[];
      sources: string[];
    }
  | {
      type: "unresolved-reexport";
      module: string;
      exportedName: string;
      source: string;
      importedName: string;
    }
  | { type: "unknown-module"; module: string; source: string };

export type ExportMap = Map<string, Map<string, ResolvedExport>>;

export interface RoundSnapshot {
  round: number;
  exports: ExportMap;
}

export interface LinkResult {
  /** Resolved exports per module path (converged fixed point). */
  exports: ExportMap;
  diagnostics: Diagnostic[];
  /** Number of merge rounds executed (including the seed round). */
  rounds: number;
  /** Per-round snapshots, present only when `trace` was enabled. */
  snapshots?: RoundSnapshot[];
}

export interface LinkOptions {
  /** Record every round so callers can verify convergence themselves. */
  trace?: boolean;
  /** Safety bound on iterations. Defaults to a graph-size-based bound. */
  maxRounds?: number;
}

function bindingKey(ref: BindingRef): string {
  return `${ref.module}#${ref.name}`;
}

function cloneExportMap(map: ExportMap): ExportMap {
  const copy: ExportMap = new Map();
  for (const [mod, entries] of map) {
    const inner = new Map<string, ResolvedExport>();
    for (const [name, info] of entries) {
      inner.set(name, { name, origin: { ...info.origin }, path: [...info.path] });
    }
    copy.set(mod, inner);
  }
  return copy;
}

/** Structural equality used to verify a round against its reference round. */
function exportMapsEqual(a: ExportMap, b: ExportMap): boolean {
  if (a.size !== b.size) return false;
  for (const [mod, entriesA] of a) {
    const entriesB = b.get(mod);
    if (!entriesB || entriesB.size !== entriesA.size) return false;
    for (const [name, infoA] of entriesA) {
      const infoB = entriesB.get(name);
      if (!infoB) return false;
      if (bindingKey(infoA.origin) !== bindingKey(infoB.origin)) return false;
      if (infoA.path.length !== infoB.path.length) return false;
      for (let i = 0; i < infoA.path.length; i++) {
        if (infoA.path[i] !== infoB.path[i]) return false;
      }
    }
  }
  return true;
}

interface StarCandidate {
  origin: BindingRef;
  path: string[];
  via: string;
}

interface RoundOutcome {
  next: ExportMap;
  diagnostics: Diagnostic[];
}

/**
 * One full-graph merge round: recompute every module's export map from
 * the reference (previous round) state.
 */
function mergeRound(modules: ModuleSpec[], reference: ExportMap): RoundOutcome {
  const next: ExportMap = new Map();
  const diagnostics: Diagnostic[] = [];

  for (const mod of modules) {
    const merged = new Map<string, ResolvedExport>();
    const starCandidates = new Map<string, StarCandidate[]>();

    for (const source of mod.starExports ?? []) {
      const sourceExports = reference.get(source);
      if (!sourceExports) {
        diagnostics.push({ type: "unknown-module", module: mod.path, source });
        continue;
      }
      for (const [name, info] of sourceExports) {
        const candidate: StarCandidate = {
          origin: info.origin,
          path: [mod.path, ...info.path],
          via: source,
        };
        const list = starCandidates.get(name);
        if (list) list.push(candidate);
        else starCandidates.set(name, [candidate]);
      }
    }

    for (const [name, candidates] of starCandidates) {
      const distinct = new Map<string, StarCandidate>();
      for (const candidate of candidates) {
        const key = bindingKey(candidate.origin);
        const prev = distinct.get(key);
        // Same binding via multiple paths: keep the shortest path.
        if (!prev || candidate.path.length < prev.path.length) {
          distinct.set(key, candidate);
        }
      }
      if (distinct.size > 1) {
        diagnostics.push({
          type: "ambiguous-star-export",
          module: mod.path,
          name,
          origins: [...distinct.values()].map((c) => c.origin),
          sources: candidates.map((c) => c.via),
        });
        continue; // ambiguous names are not exported
      }
      const winner = [...distinct.values()][0]!;
      merged.set(name, { name, origin: winner.origin, path: winner.path });
    }

    // Explicit exports take priority over anything gathered via stars.
    for (const explicit of mod.exports ?? []) {
      if (explicit.source !== undefined) {
        const importedName = explicit.importedName ?? explicit.exportedName;
        const sourceExports = reference.get(explicit.source);
        if (!sourceExports) {
          diagnostics.push({ type: "unknown-module", module: mod.path, source: explicit.source });
          continue;
        }
        const target = sourceExports.get(importedName);
        if (!target) continue; // not resolvable yet this round
        merged.set(explicit.exportedName, {
          name: explicit.exportedName,
          origin: target.origin,
          path: [mod.path, ...target.path],
        });
      } else {
        const localName = explicit.localName ?? explicit.exportedName;
        merged.set(explicit.exportedName, {
          name: explicit.exportedName,
          origin: { module: mod.path, name: localName },
          path: [mod.path],
        });
      }
    }

    next.set(mod.path, merged);
  }

  return { next, diagnostics };
}

/**
 * Seed round: only local explicit exports are known; aliased re-exports
 * and star exports resolve in subsequent rounds.
 */
function seed(modules: ModuleSpec[]): ExportMap {
  const state: ExportMap = new Map();
  for (const mod of modules) {
    const entries = new Map<string, ResolvedExport>();
    for (const explicit of mod.exports ?? []) {
      if (explicit.source !== undefined) continue;
      const localName = explicit.localName ?? explicit.exportedName;
      entries.set(explicit.exportedName, {
        name: explicit.exportedName,
        origin: { module: mod.path, name: localName },
        path: [mod.path],
      });
    }
    state.set(mod.path, entries);
  }
  return state;
}

/**
 * Diagnostics that only make sense once the fixed point is reached:
 * aliased re-exports whose target never appeared.
 */
function finalDiagnostics(modules: ModuleSpec[], converged: ExportMap): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const mod of modules) {
    for (const explicit of mod.exports ?? []) {
      if (explicit.source === undefined) continue;
      const importedName = explicit.importedName ?? explicit.exportedName;
      const sourceExports = converged.get(explicit.source);
      if (sourceExports && !sourceExports.has(importedName)) {
        diagnostics.push({
          type: "unresolved-reexport",
          module: mod.path,
          exportedName: explicit.exportedName,
          source: explicit.source,
          importedName,
        });
      }
    }
  }
  return diagnostics;
}

export function link(modules: ModuleSpec[], options: LinkOptions = {}): LinkResult {
  const maxRounds = options.maxRounds ?? modules.length * 4 + 8;
  const snapshots: RoundSnapshot[] | undefined = options.trace ? [] : undefined;

  let state = seed(modules);
  let rounds = 1;
  if (snapshots) snapshots.push({ round: 0, exports: cloneExportMap(state) });

  let diagnostics: Diagnostic[] = [];
  for (let round = 1; round <= maxRounds; round++) {
    const outcome = mergeRound(modules, state);
    rounds = round + 1;
    // Reference verification: compare the freshly merged full graph
    // against the previous round. Identical maps mean fixed point.
    if (exportMapsEqual(outcome.next, state)) {
      diagnostics = [...outcome.diagnostics, ...finalDiagnostics(modules, outcome.next)];
      state = outcome.next;
      if (snapshots) snapshots.push({ round, exports: cloneExportMap(state) });
      return { exports: state, diagnostics, rounds, snapshots };
    }
    state = outcome.next;
    if (snapshots) snapshots.push({ round, exports: cloneExportMap(state) });
  }

  throw new Error(`export linker did not converge within ${maxRounds} rounds`);
}

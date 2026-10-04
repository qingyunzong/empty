import { sha256 } from "./hash.js";
import type { ModuleRecord } from "./compiler.js";
import { stronglyConnectedComponents } from "./graph.js";

/**
 * One publishable batch. Cyclic modules collapse into a single SCC and are
 * always compiled and published together as one unit.
 */
export interface SccInfo {
  /** Deterministic id: sorted member names. */
  id: string;
  members: string[];
  /** Interface summary of the whole batch (what dependents consume). */
  ifaceHash: string;
  /**
   * Full input fingerprint: member implementation hashes plus the interface
   * hashes of external dependencies. Anything that could change the compiled
   * output is captured here — and nothing else.
   */
  fingerprint: string;
  /** Published batch artifact. */
  artifactHash: string;
}

export function moduleArtifact(sccArtifactHash: string, moduleName: string): string {
  return sha256("module\n" + moduleName + "\n" + sccArtifactHash);
}

/** Analyze the current module records into SCC batches, dependencies first. */
export function analyzeSccs(records: Map<string, ModuleRecord>): SccInfo[] {
  const names = [...records.keys()].sort();
  const edges = new Map<string, string[]>();
  for (const name of names) {
    edges.set(name, records.get(name)!.deps.filter((dep) => records.has(dep)));
  }
  const components = stronglyConnectedComponents(names, edges);

  const ifaceByModule = new Map<string, string>();
  const infos: SccInfo[] = [];
  for (const component of components) {
    const members = [...component].sort();
    const id = members.join("\n");
    const ifaceHash = sha256(
      "scc-iface\n" + members.map((m) => `${m}:${records.get(m)!.ifaceHash}`).join("\n"),
    );
    const memberSet = new Set(members);
    const externalDeps: string[] = [];
    for (const member of members) {
      for (const dep of records.get(member)!.deps) {
        if (memberSet.has(dep) || !records.has(dep)) continue;
        externalDeps.push(`${dep}:${ifaceByModule.get(dep)!}`);
      }
    }
    externalDeps.sort();
    const implPart = members.map((m) => `${m}:${records.get(m)!.implHash}`).join("\n");
    const fingerprint = sha256(
      "scc-inputs\n" + implPart + "\ndeps\n" + externalDeps.join("\n"),
    );
    const artifactHash = sha256("artifact\n" + fingerprint);
    infos.push({ id, members, ifaceHash, fingerprint, artifactHash });
    for (const member of members) ifaceByModule.set(member, ifaceHash);
  }
  return infos;
}
